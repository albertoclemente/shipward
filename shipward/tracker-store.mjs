// The only code that touches .shipward/tracker.json.
//
// Three writers share this file: the desk UI (through serve.mjs), the MCP
// server, and Claude Code editing it directly. An in-process promise chain
// cannot serialize across processes, so mutations take an advisory file lock
// that spans the read as well as the write — two processes must never start
// from the same base document.
import { readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TRACKER = process.env.SHIPWARD_TRACKER || join(HERE, '..', '.shipward', 'tracker.json');
const LOCK = `${TRACKER}.lock`;

const LOCK_STALE_MS = 5000;    // a holder this old is presumed dead
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10000;

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}
export class MissingTrackerError extends Error {
  constructor(msg) { super(msg); this.name = 'MissingTrackerError'; }
}

/* ── validation ──────────────────────────────────────────────
   Relocated verbatim from serve.mjs. The tracker is Claude Code's memory: a
   write that satisfies the caller but not .shipward/schema.json poisons the
   next session, so check the fields the schema marks required. */
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
  if (d.feed.length > 200) return 'feed exceeds the 200-entry cap';
  for (const [i, f] of d.feed.entries()) {
    if (!isObj(f)) return `feed[${i}] is not an object`;
    if (!isStr(f.t) || Number.isNaN(Date.parse(f.t))) return `feed[${i}].t must be a date-time`;
    if (!isStr(f.p)) return `feed[${i}].p must be a string`;
    if (!isStr(f.msg)) return `feed[${i}].msg must be a string`;
    if (f.by != null && f.by !== 'claude' && f.by !== 'user') return `feed[${i}].by is invalid`;
  }
  return null;
}

/* ── lock ────────────────────────────────────────────────────
   `wx` is O_EXCL — atomic create-or-fail on POSIX. The file records pid and
   timestamp so a lock left by a crashed process is recognisable as stale
   rather than merely present. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(LOCK, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = Infinity;
      try {
        age = Date.now() - (await stat(LOCK)).mtimeMs;
      } catch {
        continue;   // holder released it between our attempt and the stat
      }
      if (age > LOCK_STALE_MS) {
        process.stderr.write(`shipward: breaking stale lock (${Math.round(age)}ms old)\n`);
        await unlink(LOCK).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the tracker lock');
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export async function withLock(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    await unlink(LOCK).catch(() => {});
  }
}

/* ── io ──────────────────────────────────────────────────────── */
export async function read() {
  let raw;
  try {
    raw = await readFile(TRACKER, 'utf8');
  } catch {
    throw new MissingTrackerError('tracker.json not found at .shipward/tracker.json');
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ValidationError('tracker.json is not valid JSON');
  }
  const bad = validate(doc);
  if (bad) throw new ValidationError(`tracker.json is not a valid tracker document: ${bad}`);
  return doc;
}

export const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';

async function atomicWrite(doc) {
  const body = serialize(doc);
  const tmp = `${TRACKER}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, TRACKER);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return body;
}

// Read-modify-write under one lock. `fn` receives the current document and
// returns the replacement, or null/undefined for a no-op.
export async function mutate(fn) {
  return withLock(async () => {
    const doc = await read();
    const next = await fn(doc);
    if (!next) return { doc, body: null, changed: false };
    const bad = validate(next);
    if (bad) throw new ValidationError(`refusing to write an invalid tracker document: ${bad}`);
    const body = await atomicWrite(next);
    return { doc: next, body, changed: true };
  });
}

// Replace the whole document (the shape PUT /api/tracker needs). Validated
// before the lock so a bad body is rejected without contending for it.
export async function replace(doc) {
  const bad = validate(doc);
  if (bad) throw new ValidationError(bad);
  return withLock(() => atomicWrite(doc));
}
