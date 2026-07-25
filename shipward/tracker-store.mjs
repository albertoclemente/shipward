// The only code that touches .shipward/tracker.json.
//
// Three processes write that file: the desk UI (through serve.mjs), the MCP
// server, and Claude Code editing it directly. An in-process promise chain
// cannot serialize across processes, so mutations take an advisory file lock
// that spans the read as well as the write.
//
// The lock is deliberately paranoid, because the naive version of it lost
// writes under contention:
//   * ownership token — a holder only ever releases the lock it took, never
//     whatever happens to be at the path;
//   * break by rename — stealing a dead lock is one atomic step, so two
//     breakers cannot both win and then delete each other's fresh lock;
//   * liveness over age — a holder whose pid is alive is never stale, however
//     slow it is, and a heartbeat keeps its mtime fresh regardless;
//   * every retry path checks the deadline and sleeps, so no input can spin.
//
// SHIPWARD_TRACKER overrides the tracker path. It exists for tests. Two
// processes pointed at the same logical tracker through different values will
// derive different lock paths and will NOT serialize with each other.
import { readFile, writeFile, rename, unlink, open, lstat, stat, chmod, readdir, utimes, link } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRACKER = process.env.SHIPWARD_TRACKER || join(HERE, '..', '.shipward', 'tracker.json');
const LOCK = `${TRACKER}.lock`;
const DIR = dirname(TRACKER);
const BASE = basename(TRACKER);

const LOCK_HEARTBEAT_MS = 1000;   // holder refreshes its mtime this often
const LOCK_STALE_MS = 30000;      // backstop: a heartbeating holder never reaches this
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 60000;    // must exceed LOCK_STALE_MS, or breaking becomes the common path

export const FEED_CAP = 200;

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}
export class MissingTrackerError extends Error {
  constructor(msg) { super(msg); this.name = 'MissingTrackerError'; }
}
export class TrackerReadError extends Error {
  constructor(msg) { super(msg); this.name = 'TrackerReadError'; }
}

/* ── validation ──────────────────────────────────────────────
   The tracker is Claude Code's memory: a write that satisfies the caller but
   not .shipward/schema.json poisons the next session. */
const STATUS = new Set(['backlog', 'claude', 'review', 'pushed', 'shipped']);
const CLAUDE = new Set(['queued', 'working', 'done']);
const TYPE = new Set(['feature', 'bug', 'chore']);
const PRI = new Set(['P1', 'P2', 'P3']);
const EFFORT = new Set(['S', 'M', 'L']);
const ID_RE = /^[A-Z]+-[0-9]{3}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isTime = (v) => v == null || (isStr(v) && !Number.isNaN(Date.parse(v)));

export function validate(d) {
  if (!isObj(d)) return 'not an object';
  if (d.version !== 1) return 'version must be 1';
  for (const k of ['projects', 'cards', 'feed']) if (!Array.isArray(d[k])) return `${k} must be an array`;

  for (const [i, p] of d.projects.entries()) {
    if (!isObj(p)) return `projects[${i}] is not an object`;
    for (const k of ['id', 'name', 'prefix']) if (!isStr(p[k])) return `projects[${i}].${k} must be a string`;
  }
  const seen = new Set();
  for (const [i, c] of d.cards.entries()) {
    if (!isObj(c)) return `cards[${i}] is not an object`;
    if (!isStr(c.id) || !ID_RE.test(c.id)) return `cards[${i}].id must match PREFIX-NNN`;
    if (seen.has(c.id)) return `duplicate card id ${c.id}`;
    seen.add(c.id);
    if (!isStr(c.p)) return `${c.id}.p must be a string`;
    if (!isStr(c.title)) return `${c.id}.title must be a string`;
    if (!TYPE.has(c.type)) return `${c.id}.type is invalid`;
    if (!PRI.has(c.pri)) return `${c.id}.pri is invalid`;
    if (!EFFORT.has(c.effort)) return `${c.id}.effort is invalid`;
    if (!STATUS.has(c.status)) return `${c.id}.status is invalid`;
    if (c.claude != null && !CLAUDE.has(c.claude)) return `${c.id}.claude is invalid`;
    if (!isStr(c.created) || Number.isNaN(Date.parse(c.created))) return `${c.id}.created must be a date-time`;
    if (!isTime(c.pushed)) return `${c.id}.pushed must be a date-time or null`;
    if (!isTime(c.shipped)) return `${c.id}.shipped must be a date-time or null`;
  }
  for (const [i, f] of d.feed.entries()) {
    if (!isObj(f)) return `feed[${i}] is not an object`;
    if (!isStr(f.t) || Number.isNaN(Date.parse(f.t))) return `feed[${i}].t must be a date-time`;
    if (!isStr(f.p)) return `feed[${i}].p must be a string`;
    if (!isStr(f.msg)) return `feed[${i}].msg must be a string`;
    if (f.by != null && f.by !== 'claude' && f.by !== 'user') return `feed[${i}].by is invalid`;
  }
  return null;
}

// The cap is a truncation rule, not a rejection rule. Rejecting a 201-entry
// feed froze the tracker permanently once it filled, since every card write
// appends an entry.
function normalize(doc) {
  if (Array.isArray(doc.feed) && doc.feed.length > FEED_CAP) {
    return { ...doc, feed: doc.feed.slice(0, FEED_CAP) };
  }
  return doc;
}

/* ── lock ────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

async function readHolder() {
  try { return JSON.parse(await readFile(LOCK, 'utf8')); } catch { return null; }
}

// Steal a dead lock in ONE atomic step. Renaming a path succeeds for exactly
// one caller; everyone else gets ENOENT and loops. The previous version
// unlinked blind, so four processes each removed the last winner's fresh lock
// and all four entered the critical section.
async function breakLock() {
  const grave = `${LOCK}.dead.${randomUUID()}`;
  try {
    await rename(LOCK, grave);
  } catch {
    return false;                        // someone else broke it first
  }
  await unlink(grave).catch(() => {});
  await sweepTmp();                      // the dead holder may have orphaned one
  return true;
}

async function isStale() {
  const holder = await readHolder();
  if (holder && alive(holder.pid)) return false;     // slow but alive is not stale
  let age;
  try {
    age = Date.now() - (await lstat(LOCK)).mtimeMs;
  } catch {
    return false;                                     // vanished; just retry
  }
  if (age < 0) return true;                           // clock skew: as broken as too old
  // Unparsable means a symlink, a truncated write, or a corpse — but give it a
  // grace period so a transient read can never condemn a live holder.
  if (!holder) return age > 2000;
  return age > LOCK_STALE_MS;
}

// Publish the lock atomically: build it complete in a scratch file, then link
// it into place. link() fails EEXIST if the lock is held, so it is exclusive —
// and unlike open(wx) it never leaves an EMPTY lock visible. That window was
// real: under contention a process starved between create and stamp, waiters
// read a bodyless lock, judged it broken, and broke a live holder's.
async function publish(token) {
  const scratch = join(DIR, `${BASE}.lock.${process.pid}.${randomUUID()}`);
  await writeFile(scratch, JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8');
  try {
    await link(scratch, LOCK);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(scratch).catch(() => {});
  }
}

async function acquire() {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      if (await publish(token)) return token;
      const err = new Error('lock held');
      err.code = 'EEXIST';
      throw err;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await isStale()) {
        if (await breakLock()) {
          process.stderr.write('shipward: broke a stale tracker lock\n');
        }
      }
      // Every path below reaches the deadline check and the sleep. Two of them
      // used to `continue` past both and spin at 100% CPU.
      if (Date.now() > deadline) throw new Error(`timed out waiting for the tracker lock at ${LOCK}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function release(token) {
  const holder = await readHolder();
  if (holder?.token !== token) return;   // ours was already broken; do not delete a live holder's
  await unlink(LOCK).catch(() => {});
}

export async function withLock(fn) {
  const token = await acquire();
  // Keep our mtime fresh so a long mutation is never mistaken for a corpse.
  // utimes, not writeFile: rewriting the body truncates it, and a waiter that
  // read during that window saw an invalid lock and broke a live holder's.
  const beat = setInterval(() => {
    const now = new Date();
    utimes(LOCK, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await release(token);
  }
}

/* ── io ──────────────────────────────────────────────────────── */
async function sweepTmp() {
  try {
    for (const f of await readdir(DIR)) {
      if (!f.startsWith(`${BASE}.`)) continue;
      // orphan atomic-write temps, and lock scratch files from a killed publish
      if (f.endsWith('.tmp') || /\.lock\.\d+\./.test(f)) await unlink(join(DIR, f)).catch(() => {});
    }
  } catch { /* directory unreadable — nothing to sweep */ }
}

// Returns the bytes as well as the parsed document: GET serves the file's own
// bytes, so a poll cannot silently reformat what Claude Code wrote.
export async function readRaw() {
  let raw;
  try {
    raw = await readFile(TRACKER, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new MissingTrackerError(`tracker.json not found at ${TRACKER}`);
    throw new TrackerReadError(`cannot read ${TRACKER}: ${err.code}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ValidationError('tracker.json is not valid JSON');
  }
  const bad = validate(doc);
  if (bad) throw new ValidationError(`tracker.json is not a valid tracker document: ${bad}`);
  return { raw, doc };
}

export const read = async () => (await readRaw()).doc;
export const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';

async function atomicWrite(doc) {
  const body = serialize(doc);
  const tmp = join(DIR, `${BASE}.${process.pid}.${randomUUID()}.tmp`);
  // Preserve the tracker's mode: rename swaps in a new inode, so a file the
  // user chmod'd to 600 came back 644 after one write.
  const mode = await stat(TRACKER).then((s) => s.mode & 0o777).catch(() => null);
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();                       // durable before the rename
    } finally {
      await fh.close().catch(() => {});
    }
    if (mode != null) await chmod(tmp, mode);
    await rename(tmp, TRACKER);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return body;
}

// Read-modify-write under one lock. `fn` receives the current document and
// returns the replacement, or null/undefined for a deliberate no-op.
export async function mutate(fn) {
  return withLock(async () => {
    const doc = await read();
    const before = serialize(doc);
    const next = await fn(doc);

    if (next == null) {
      // A forgotten `return` used to be indistinguishable from an intentional
      // no-op: nothing was written and the caller got back the dirty doc.
      if (serialize(doc) !== before) {
        throw new ValidationError('mutate callback changed the document in place but returned nothing — return the document to persist it');
      }
      return { doc, body: null, changed: false };
    }
    if (!isObj(next)) throw new ValidationError('mutate callback must return a document object or null');

    const out = normalize(next);
    const bad = validate(out);
    if (bad) throw new ValidationError(`refusing to write an invalid tracker document: ${bad}`);
    const body = await atomicWrite(out);
    return { doc: out, body, changed: true };
  });
}

// Replace the whole document — the shape PUT /api/tracker needs. Validated
// before the lock so a bad body never contends for it.
//
// NOTE: the caller's base document came from an earlier unlocked GET, so this
// is last-write-wins by construction. See SW-008.
export async function replace(doc) {
  const out = normalize(doc);
  const bad = validate(out);
  if (bad) throw new ValidationError(bad);
  return withLock(async () => ({ doc: out, body: await atomicWrite(out), changed: true }));
}
