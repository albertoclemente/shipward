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
//   * one observation — staleness is judged from a single open handle, never
//     from a stat and a read that could land on two different locks;
//   * a future mtime means new, not dead — filesystem timestamps carry
//     sub-millisecond precision that Date.now() truncates away;
//   * the sweep only collects files whose pid is dead;
//   * every retry path checks the deadline and sleeps, so no input can spin.
//
// SHIPWARD_TRACKER overrides the tracker path. It exists for tests. Two
// processes pointed at the same logical tracker through different values will
// derive different lock paths and will NOT serialize with each other.
import { readFile, writeFile, appendFile, rename, unlink, open, lstat, stat, chmod, readdir, utimes, link } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolution order: explicit env, then the tracker of the repo you are
// STANDING IN, then this repo's own. The middle rung is what makes one central
// install serve every onboarded project (SW-033) — `node <central>/serve.mjs`
// run inside any repo with a .shipward/ opens that repo's board, no flags.
const CWD_TRACKER = join(process.cwd(), '.shipward', 'tracker.json');
export const TRACKER = process.env.SHIPWARD_TRACKER
  || (existsSync(CWD_TRACKER) ? CWD_TRACKER : join(HERE, '..', '.shipward', 'tracker.json'));
const LOCK = `${TRACKER}.lock`;
const DIR = dirname(TRACKER);
const BASE = basename(TRACKER);

const LOCK_HEARTBEAT_MS = 1000;   // holder refreshes its mtime this often
// A holder whose pid is dead only has to be quiet for this long. It used to be
// 30s, which meant one crash cost every waiter half a minute and two crashes
// inside a single waiter's deadline was a guaranteed failure — measured, 2 of 4
// clean writers hard-failed. The pid check has already proven the holder gone;
// the grace only has to cover a check that raced with a publish.
const DEAD_GRACE_MS = 2000;
const ORPHAN_GRACE_MS = 2000;     // a lock with no readable holder behind it
// The backstop for a holder that is alive but has stopped heartbeating: wedged,
// suspended, or a pid that now belongs to something else entirely. Liveness
// used to make a lock unbreakable FOREVER — a lock 24 hours old held by pid 1
// never became breakable, and the lock lives in the working directory, so it
// survives a reboot after which that pid is very likely someone else's.
const LOCK_ABANDONED_MS = 300000;
// An mtime slightly ahead of Date.now() means brand new (see isStale). An mtime
// an hour ahead means a clock that disagrees, and treating that as new made the
// lock immortal — one backwards NTP step would freeze every existing lock.
const FUTURE_SKEW_MS = 5000;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 60000;

export const FEED_CAP = 200;

// Where feed entries go when they roll off the cap. The Log view sells itself
// as "what happened", and until SW-027 the honest answer past 200 entries was
// "deleted" — three days of use produced 87, so the cap was weeks away from
// quietly eating history. JSONL, append-only, oldest first: a log file, for a
// log.
export const FEED_ARCHIVE = process.env.SHIPWARD_FEED_ARCHIVE
  || join(DIR, 'feed-archive.jsonl');

// Identity of a feed entry for the drop diff. Two honestly identical entries
// (same instant, same message, same author) collapse to one key; archiving one
// line for the pair is an acceptable loss against the bookkeeping a count-based
// diff would cost.
const feedKey = (f) => [f?.t, f?.p, f?.by, f?.msg].join('\u0000');

// Born from the SW-033 clobber: a whole-document PUT replaced 32 cards with 1
// and the store said nothing — the feed survived because archiveDropped keeps
// drops, the cards survived only because the tracker is committed to git. A
// warning, never a gate, same doctrine as the archive: the desk legitimately
// replaces whole documents (and deletes single cards), but a massacre must not
// be silent. The floor keeps small boards quiet — dropping 1 of 2 cards is an
// edit, dropping 20 of 32 is an event.
const CARD_LOSS_FLOOR = 4;
function warnCardLoss(beforeCards, afterCards) {
  const before = Array.isArray(beforeCards) ? beforeCards.length : 0;
  const after = Array.isArray(afterCards) ? afterCards.length : 0;
  if (before < CARD_LOSS_FLOOR || after >= Math.ceil(before / 2)) return;
  process.stderr.write(
    `shipward: WARNING — this write drops ${before - after} of ${before} cards from ${TRACKER}. `
    + 'Cards are never deleted by protocol; if this was not deliberate, the previous state is in git.\n',
  );
}

// Everything the write is about to discard, appended BEFORE the write: if the
// write then fails the tracker still holds the entries and the next successful
// write re-archives them — a duplicate line in an archive is noise, a lost one
// is the exact failure this file exists to prevent. Runs under the same lock as
// the write, so appends cannot interleave. Never throws: an unwritable archive
// must not take the tracker write with it — but it is also not silent, because
// "archived" that didn't happen is the lie this feature exists to end.
async function archiveDropped(oldFeed, newFeed) {
  if (!Array.isArray(oldFeed) || !oldFeed.length) return;
  const kept = new Set((Array.isArray(newFeed) ? newFeed : []).map(feedKey));
  const dropped = oldFeed.filter((f) => !kept.has(feedKey(f)));
  if (!dropped.length) return;
  // The feed is newest-first; the archive reads oldest-first, like a log.
  const lines = dropped.reverse().map((f) => JSON.stringify(f)).join('\n') + '\n';
  try {
    await appendFile(FEED_ARCHIVE, lines, 'utf8');
  } catch (err) {
    process.stderr.write(`shipward: could not archive ${dropped.length} feed entr${dropped.length === 1 ? 'y' : 'ies'} to ${FEED_ARCHIVE}: ${err.code || err.message}\n`);
  }
}

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}
export class MissingTrackerError extends Error {
  constructor(msg) { super(msg); this.name = 'MissingTrackerError'; }
}
export class TrackerReadError extends Error {
  constructor(msg) { super(msg); this.name = 'TrackerReadError'; }
}
// Thrown when a caller's base document is no longer current. Carries the
// document that actually won, so the caller can re-apply its intent to it.
export class ConflictError extends Error {
  constructor(msg, current) { super(msg); this.name = 'ConflictError'; this.current = current; }
}

// Content-derived, so it is stable across re-reads and changes only when the
// bytes do — unlike mtime, which a heartbeat or a touch would move.
export const etagOf = (raw) => `"${createHash('sha256').update(raw).digest('hex').slice(0, 16)}"`;

/* ── the notes sidecar (SW-039) ──────────────────────────────
   Note text is 68-73% of every tracker measured (shipward 116 KB of 169 KB,
   Catch 38 KB of 52 KB), it is append-only by protocol, and cards are never
   deleted — so the one file grew without bound and took `git diff` and the
   documented MCP-offline fallback ("read → modify → write the whole file")
   down with it.

   So note ENTRIES live in .shipward/notes.jsonl and the tracker holds board
   state. This module is the only code that knows: read() hydrates card.note
   from the sidecar and every writer strips it back out, so all fifteen call
   sites above the store still see card.note as an array and still append to it
   through appendedNote(). Nothing above this file changed.

   SW-007 rejected a sidecar for the MCP heartbeat, on the grounds that one
   occasionally dirty file beats two that can disagree. That objection does not
   reach here, and the difference is the whole design: these two files hold
   DISJOINT facts. The tracker never carries note text after a write, the
   sidecar never carries board state, so there is no fact for them to disagree
   about — where the heartbeat would have been duplicated in both.

   Append-only, oldest first, one JSON object per line. Never rewritten and
   never compacted: it is the memory, and the protocol above it says push an
   entry, never edit one. */
export const NOTES = process.env.SHIPWARD_NOTES || join(DIR, 'notes.jsonl');

// Identity of a note entry, and the reason a duplicate append is survivable.
// NUL-joined for the same reason feedKey is: no timestamp, card id or note
// body can contain it, so two different entries cannot collide by containing
// the separator.
const noteKey = (card, e) => [card, e?.t, e?.text].join('\u0000');

// Claude appends prose segments with " || ". Duplicated from memory-lib's
// SEGMENT_SEP rather than imported: the store deliberately imports nothing
// from public/, the same way NOTE_KIND mirrors ALL_KINDS below.
const SEGMENT_SEP = ' || ';

// A card's note as entries, whatever form the caller left it in. A plain-string
// note is legacy (CLAUDE.md still blesses hand-editing) and converts here,
// stamped with the card's own clock — the date a reader would have guessed for
// it anyway, and the same fallback appendedNote() uses.
function noteEntries(card) {
  const n = card?.note;
  if (n == null || n === '') return [];
  if (Array.isArray(n)) return n.filter((e) => isObj(e) && isStr(e.text) && e.text.trim());
  if (!isStr(n)) return [];
  return n.split(SEGMENT_SEP).map((s) => s.trim()).filter(Boolean)
    .map((text) => ({ t: card.created, text }));
}

const noteRecord = (cardId, e) => {
  const rec = { card: cardId, t: e.t, text: e.text };
  if (e.kind != null) rec.kind = e.kind;
  if (e.resolves != null) rec.resolves = e.resolves;
  return rec;
};

// A missing sidecar is a board that has never written a note, not an error —
// every one of the ten onboarded repos starts that way. A line that will not
// parse is skipped and COUNTED on stderr: silently dropping memory is the
// failure this file exists to prevent, and the tracker is in git.
async function readNotes() {
  let raw = '';
  try {
    raw = await readFile(NOTES, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new TrackerReadError(`cannot read ${NOTES}: ${err.code}`);
    return { raw: '', byCard: new Map(), keys: new Set() };
  }
  return { raw, ...parseNotes(raw) };
}

// The pure half, with no path in it. Exported because the tests need to read a
// board the way every consumer sees it, and a second implementation of this in
// the test files would be free to drift from the one that ships.
export function parseNotes(raw) {
  const byCard = new Map();
  const keys = new Set();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { skipped++; continue; }
    if (!isObj(e) || !isStr(e.card) || !isStr(e.text) || !isStr(e.t)) { skipped++; continue; }
    const k = noteKey(e.card, e);
    if (keys.has(k)) continue;             // a re-append after a failed write
    keys.add(k);
    const entry = { t: e.t, text: e.text };
    if (e.kind != null) entry.kind = e.kind;
    if (e.resolves != null) entry.resolves = e.resolves;
    if (!byCard.has(e.card)) byCard.set(e.card, []);
    byCard.get(e.card).push(entry);
  }
  if (skipped) {
    process.stderr.write(`shipward: skipped ${skipped} unreadable line${skipped === 1 ? '' : 's'} in ${NOTES}\n`);
  }
  return { byCard, keys };
}

// Sidecar entries onto the cards. Any note still inline is legacy or a
// half-finished migration; it is merged rather than ignored, deduped by
// identity so a re-append cannot double it, and ordered by its own clock.
// Array.prototype.sort is stable, so entries stamped in the same millisecond
// keep the order they were appended in.
export function hydrate(doc, byCard) {
  return {
    ...doc,
    cards: doc.cards.map((c) => {
      const seen = new Set();
      const merged = [];
      for (const e of [...noteEntries(c), ...(byCard.get(c.id) || [])]) {
        const k = noteKey(c.id, e);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(e);
      }
      merged.sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
      // Stripped and re-added rather than spread over, so `note` lands in the
      // same place whatever the input looked like. A hand-written tracker puts
      // it mid-object and a written one has no `note` key at all, and without
      // this a read-only tool call appeared to rewrite the whole board — the
      // document was identical, only the key order moved.
      const { note, ...rest } = c;
      return { ...rest, note: merged };
    }),
  };
}

// The write half: the document as it goes to disk, plus the lines the sidecar
// does not have yet. On a tracker that has never been split, EVERY entry is
// new — which is exactly the migration, performed by the first write and
// needing no separate step or flag day.
//
// Entries the incoming document has DROPPED are not removed from the sidecar.
// Cards are never deleted by protocol and notes are append-only, so a
// disappearing entry is a caller mistake or a stale base, and the next read
// hands it back. The sidecar can gain memory it should not have; it cannot
// lose memory it should.
function extract(doc, keys) {
  const lines = [];
  const cards = doc.cards.map((c) => {
    for (const e of noteEntries(c)) {
      const k = noteKey(c.id, e);
      if (keys.has(k)) continue;
      keys.add(k);                         // also dedups within this one write
      lines.push(JSON.stringify(noteRecord(c.id, e)));
    }
    const { note, ...rest } = c;
    return rest;
  });
  return { stripped: { ...doc, cards }, lines };
}

// Unlike archiveDropped, this one THROWS. The feed archive is a copy of
// something the tracker still holds; this is the only copy there is, so a
// sidecar that will not take the write must fail the write rather than let the
// tracker be rewritten without it.
async function appendNotes(lines) {
  if (!lines.length) return '';
  const body = `${lines.join('\n')}\n`;
  await appendFile(NOTES, body, 'utf8');
  return body;
}

// One etag over BOTH files: the desk's If-Match has to notice a note that
// landed as surely as a card that moved, and after SW-039 those live in
// different files.
const stateEtag = (trackerRaw, notesRaw) => etagOf(`${trackerRaw}\u0000${notesRaw}`);

/* ── validation ──────────────────────────────────────────────
   The tracker is Claude Code's memory: a write that satisfies the caller but
   not .shipward/schema.json poisons the next session. */
const STATUS = new Set(['backlog', 'claude', 'review', 'pushed', 'shipped']);
const CLAUDE = new Set(['queued', 'working', 'done']);
const TYPE = new Set(['feature', 'bug', 'chore']);
const PRI = new Set(['P1', 'P2', 'P3']);
const EFFORT = new Set(['S', 'M', 'L']);
const NOTE_KIND = new Set(['open', 'finding', 'decision', 'evidence', 'outcome', 'brief']);
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
    // SW-043. A check is an argv array, never a shell string: this document is
    // written by an agent and by an unauthenticated PUT, and a string that
    // reaches a shell is a payload seam. Validated here rather than at the run
    // site so a malformed check is refused at the write, not discovered by the
    // first done() that tries to honour it.
    if (p.checks != null) {
      if (!isObj(p.checks)) return `projects[${i}].checks must be an object of name → argv`;
      for (const [name, argv] of Object.entries(p.checks)) {
        if (!Array.isArray(argv) || argv.length === 0) return `projects[${i}].checks.${name} must be a non-empty argv array`;
        if (!argv.every(isStr)) return `projects[${i}].checks.${name} must contain only strings`;
      }
    }
    if (p.checkTimeoutMs != null && (!Number.isInteger(p.checkTimeoutMs) || p.checkTimeoutMs <= 0)) {
      return `projects[${i}].checkTimeoutMs must be a positive integer`;
    }
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
    // `note` was the one card field never checked, and it is the field the whole
    // memory surface reads. A number or an object here passed validation, was
    // written verbatim, and then threw out of standup, recall, the memory view
    // and the SessionStart hook — which emitted zero bytes, so the session
    // silently got no standup at all. Cards cannot be deleted by protocol, so
    // recovery meant hand-editing the file.
    //
    // Since SW-028 a note is either prose (still supported — hand-editing the
    // tracker is documented as a fallback) or an array of dated entries. The
    // kind set mirrors memory-lib's ALL_KINDS; kept literal here because the
    // store deliberately imports nothing from public/.
    if (c.note != null && !isStr(c.note)) {
      if (!Array.isArray(c.note)) return `${c.id}.note must be a string or an array of entries`;
      for (const [j, e] of c.note.entries()) {
        if (!isObj(e)) return `${c.id}.note[${j}] is not an object`;
        if (!isStr(e.text)) return `${c.id}.note[${j}].text must be a string`;
        if (!isStr(e.t) || Number.isNaN(Date.parse(e.t))) return `${c.id}.note[${j}].t must be a date-time`;
        if (e.kind != null && !NOTE_KIND.has(e.kind)) return `${c.id}.note[${j}].kind is invalid`;
        // SW-044. The sha an entry was true of. Optional forever: every entry
        // written before this existed has none, and the honest reading of a
        // missing sha is "cannot be expired", not "still current".
        if (e.sha != null && !isStr(e.sha)) return `${c.id}.note[${j}].sha must be a string`;
        if (e.dirty != null && typeof e.dirty !== 'boolean') return `${c.id}.note[${j}].dirty must be a boolean`;
        if (e.resolves != null && (!isStr(e.resolves) || !ID_RE.test(e.resolves))) {
          return `${c.id}.note[${j}].resolves must be a card id`;
        }
      }
    }
    // SW-043. `check` is a NAME, resolved against the project's declared map at
    // run time — a name nothing declares leaves the card unverified rather than
    // executing anything. `verification` is the record of what was proved and
    // about which tree; `sha` is what SW-044 reads to decide it has expired.
    if (c.check != null && !isStr(c.check)) return `${c.id}.check must be a check name or null`;
    if (c.verification != null) {
      const v = c.verification;
      if (!isObj(v)) return `${c.id}.verification must be an object or null`;
      if (!isStr(v.check)) return `${c.id}.verification.check must be a string`;
      if (typeof v.ok !== 'boolean') return `${c.id}.verification.ok must be a boolean`;
      if (v.exit != null && !Number.isInteger(v.exit)) return `${c.id}.verification.exit must be an integer or null`;
      if (!isStr(v.at) || Number.isNaN(Date.parse(v.at))) return `${c.id}.verification.at must be a date-time`;
      if (v.sha != null && !isStr(v.sha)) return `${c.id}.verification.sha must be a string or null`;
      if (v.dirty != null && typeof v.dirty !== 'boolean') return `${c.id}.verification.dirty must be a boolean`;
      if (v.timedOut != null && typeof v.timedOut !== 'boolean') return `${c.id}.verification.timedOut must be a boolean`;
      if (v.ms != null && !Number.isInteger(v.ms)) return `${c.id}.verification.ms must be an integer`;
      if (v.argv != null && (!Array.isArray(v.argv) || !v.argv.every(isStr))) return `${c.id}.verification.argv must be an array of strings`;
    }
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

// One observation of one inode: mtime and holder come from the same open file
// handle. Reading them separately was a lost-write bug — readHolder() could hit
// the lock during its momentary absence between a release and the next publish,
// return null, and then lstat() measured a DIFFERENT, brand-new lock.
// `ino` lets the breaker confirm it is breaking the lock it actually judged.
async function inspect() {
  let fh;
  try {
    fh = await open(LOCK, 'r');
  } catch {
    // Unopenable, but the path may still exist and still block link(): a
    // dangling symlink opens ENOENT while lstat succeeds. lstat, not stat —
    // stat follows the link to the missing target and reports it gone.
    try {
      const st = await lstat(LOCK);
      return { ino: st.ino, mtimeMs: st.mtimeMs, holder: null, unreadable: true };
    } catch {
      return null;                                     // genuinely free
    }
  }
  try {
    const st = await fh.stat();
    let holder = null;
    try { holder = JSON.parse(await fh.readFile('utf8')); } catch { /* corpse or torn */ }
    return { ino: st.ino, mtimeMs: st.mtimeMs, holder, unreadable: false };
  } finally {
    await fh.close().catch(() => {});
  }
}

// A lock is stale only when nothing alive is behind it AND it has stopped
// heartbeating for the full grace period.
function isStale(snap) {
  if (!snap) return false;                             // nothing there to break
  const age = Date.now() - snap.mtimeMs;
  // A future mtime means brand new, not broken. st.mtimeMs keeps sub-millisecond
  // precision while Date.now() truncates to whole milliseconds, so a lock created
  // moments ago reads as up to ~1ms ahead — measured on 54% of fresh locks. The
  // old `age < 0 → stale` rule therefore condemned most newborn locks outright.
  // Beyond a few seconds ahead it is not precision, it is a broken clock, and
  // an unbounded allowance made those locks immortal.
  if (age < -FUTURE_SKEW_MS) return true;
  if (age < 0) return false;
  // A living holder heartbeats every second, so its mtime is always fresh.
  // Liveness on its own is not proof of progress — it is proof of a pid.
  if (snap.holder && alive(snap.holder.pid)) return age > LOCK_ABANDONED_MS;
  // No readable holder behind it: a dangling symlink, a foreign file, or a
  // corpse. Nothing will ever heartbeat it, so the long grace buys nothing —
  // and it can no longer be one of our own live locks, because publish() links
  // a fully written scratch into place and inspect() reads body and mtime from
  // that one inode. A short grace still covers an unlucky moment.
  return age > (snap.holder ? DEAD_GRACE_MS : ORPHAN_GRACE_MS);
}

// Steal a dead lock in ONE atomic step. Renaming a path succeeds for exactly
// one caller; everyone else gets ENOENT and loops. The previous version
// unlinked blind, so four processes each removed the last winner's fresh lock
// and all four entered the critical section.
//
// `snap` is what we judged. rename() moves whatever sits at the path NOW, which
// may already be someone else's fresh lock, so the grave is checked afterwards
// and an innocent lock is put back.
async function breakLock(snap) {
  // Re-read immediately before the rename and abort if the lock is no longer
  // the one we condemned. rename() moves whatever is at the path NOW, and the
  // check used to happen only afterwards — by which point a third process could
  // have published there and the link-back would delete its lock instead.
  if (snap) {
    const now = await inspect();
    if (!now || now.ino !== snap.ino) return false;
  }
  const grave = `${LOCK}.dead.${randomUUID()}`;
  try {
    await rename(LOCK, grave);
  } catch {
    return false;                        // someone else broke it first
  }
  const graved = await lstat(grave).catch(() => null);   // lstat: the lock may be a symlink
  if (graved && snap && graved.ino !== snap.ino) {
    // Not the corpse we condemned. Put it back if the path is still free; if
    // someone has already published there, drop ours rather than clobber theirs.
    try {
      await link(grave, LOCK);
    } catch {
      // We took a live holder's only lock and cannot give it back. It will
      // discover this at commit and refuse to write, but say so loudly: this
      // path should now be unreachable.
      process.stderr.write('shipward: broke a lock that was not the one judged stale\n');
    }
    await unlink(grave).catch(() => {});
    return false;
  }
  await unlink(grave).catch(() => {});
  await sweepTmp();                      // the dead holder may have orphaned one
  return true;
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

async function acquire(signal) {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw new CancelledError('cancelled while waiting for the tracker lock');
    try {
      if (await publish(token)) return token;
      const err = new Error('lock held');
      err.code = 'EEXIST';
      throw err;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const snap = await inspect();
      if (isStale(snap) && await breakLock(snap)) {
        process.stderr.write('shipward: broke a stale tracker lock\n');
      }
      // Every path below reaches the deadline check and the sleep. Two of them
      // used to `continue` past both and spin at 100% CPU.
      if (Date.now() > deadline) throw new Error(`timed out waiting for the tracker lock at ${LOCK}`);
      // Jittered, because a fixed poll is not a queue: under load the same
      // process lost the race over and over — every one of 17 timed-out writes
      // in a 2100-write run belonged to a single starved writer.
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }
}

async function release(token) {
  const holder = await readHolder();
  if (holder?.token !== token) return;   // ours was already broken; do not delete a live holder's
  // A swallowed error here leaked a lock carrying a LIVE pid, which nothing
  // would then break — one transient EACCES wedged a long-running server for
  // the rest of its life. Retry, and if it still will not go, say so.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await unlink(LOCK); return; } catch (err) {
      if (err.code === 'ENOENT') return;
      await sleep(LOCK_RETRY_MS);
    }
  }
  process.stderr.write(`shipward: could not release the tracker lock at ${LOCK} — remove it by hand if writes hang\n`);
}

// Thrown when a caller abandons the work before it was committed. Distinct from
// a failure: nothing went wrong, and nothing was written.
export class CancelledError extends Error {
  constructor(msg) { super(msg); this.name = 'CancelledError'; }
}

// Thrown when a holder discovers, just before committing, that the lock it took
// is no longer at the path. Loud beats silent: the caller can retry, where a
// blind write would overwrite whoever holds it now.
export class LockLostError extends Error {
  constructor(msg) { super(msg); this.name = 'LockLostError'; }
}

// `fn` is handed a guard to call immediately before it commits anything. Every
// known way to lose a lock has been closed, so this should never fire — it is
// here so that if one is ever reopened, the symptom is an error rather than a
// vanished card.
// This process's own token while it holds the lock. A nested mutate() used to
// wait on a lock it already owned and fail 60 seconds later with a timeout that
// blamed contention.
let heldToken = null;

export async function withLock(fn, { signal } = {}) {
  if (heldToken) {
    throw new Error('the tracker lock is already held by this process — a nested mutate() would deadlock against itself');
  }
  const token = await acquire(signal);
  heldToken = token;
  const held = async () => {
    const holder = await readHolder();
    if (holder?.token !== token) {
      throw new LockLostError('lost the tracker lock mid-write — another process took it; nothing was written');
    }
  };
  // Keep our mtime fresh so a long mutation is never mistaken for a corpse.
  // utimes, not writeFile: rewriting the body truncates it, and a waiter that
  // read during that window saw an invalid lock and broke a live holder's.
  const beat = setInterval(async () => {
    // Only ever refresh OUR lock. Touching the path meant a holder whose lock
    // had been broken kept someone else's corpse looking alive indefinitely,
    // and the next writer timed out against a dead holder it could not break.
    const holder = await readHolder();
    if (holder?.token !== token) return;
    const now = new Date();
    await utimes(LOCK, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await fn(held);
  } finally {
    clearInterval(beat);
    heldToken = null;
    await release(token);
  }
}

/* ── io ──────────────────────────────────────────────────────── */
// Both scratch kinds carry the pid of whoever made them, and only a DEAD pid's
// files are swept. Sweeping by name alone deleted a live holder's in-flight
// atomic-write temp out from under it — its rename then failed ENOENT mid-write.
const TMP_RE = new RegExp(`^${escapeRe(BASE)}\\.(\\d+)\\.[0-9a-f-]+\\.tmp$`);
const SCRATCH_RE = new RegExp(`^${escapeRe(BASE)}\\.lock\\.(\\d+)\\.[0-9a-f-]+$`);
// A grave carries no pid — it is the corpse of a lock, not of a process — so it
// is collected on age instead. Nothing matched it before and they accumulated.
const GRAVE_RE = new RegExp(`^${escapeRe(BASE)}\\.lock\\.dead\\.[0-9a-f-]+$`);
const GRAVE_MAX_AGE_MS = 60000;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function sweepTmp() {
  try {
    for (const f of await readdir(DIR)) {
      if (GRAVE_RE.test(f)) {
        const age = await lstat(join(DIR, f)).then((st) => Date.now() - st.mtimeMs).catch(() => 0);
        if (age > GRAVE_MAX_AGE_MS) await unlink(join(DIR, f)).catch(() => {});
        continue;
      }
      const m = TMP_RE.exec(f) || SCRATCH_RE.exec(f);
      if (!m || alive(Number(m[1]))) continue;
      await unlink(join(DIR, f)).catch(() => {});
    }
  } catch { /* directory unreadable — nothing to sweep */ }
}

// Returns the serialized document as well as the parsed one, because GET
// serves those bytes directly.
//
// Before SW-039 `raw` was literally the file's bytes, so a poll could not
// reformat what Claude Code wrote by hand. It is now the serialization of the
// HYDRATED document: the notes live in a second file, and bytes from one file
// alone would serve the desk a board with no memory on it. The guarantee that
// replaced it is the etag, which spans both files — a hand edit still cannot
// be silently overwritten, it is just detected by content rather than by
// identity of bytes.
export async function readRaw() {
  let fileRaw;
  try {
    fileRaw = await readFile(TRACKER, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new MissingTrackerError(`tracker.json not found at ${TRACKER}`);
    throw new TrackerReadError(`cannot read ${TRACKER}: ${err.code}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fileRaw);
  } catch {
    throw new ValidationError('tracker.json is not valid JSON');
  }
  const bad = validate(parsed);
  if (bad) throw new ValidationError(`tracker.json is not a valid tracker document: ${bad}`);

  const notes = await readNotes();
  const doc = hydrate(parsed, notes.byCard);
  // Validated AGAIN after hydration: the sidecar is a separate file that a
  // human can edit, and an entry with a bad kind or a malformed `resolves`
  // would otherwise reach every reader unchecked. readNotes only guarantees
  // the line parsed and carried the three fields it is keyed by.
  const badHydrated = validate(doc);
  if (badHydrated) throw new ValidationError(`${NOTES} holds an entry the tracker schema rejects: ${badHydrated}`);

  return { raw: serialize(doc), doc, etag: stateEtag(fileRaw, notes.raw), notes };
}

export const read = async () => (await readRaw()).doc;
export const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';

async function atomicWrite(doc, held) {
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
    // The last instant before the write becomes visible. Checking ownership
    // before all of this left a window as wide as the commit itself — measured
    // p50 5.17ms, max 16.17ms on a realistic tracker, the same order as the
    // retry poll. A card vanished inside it with no error raised anywhere.
    // Nothing is published if we no longer hold the lock.
    if (held) await held();
    await rename(tmp, TRACKER);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return body;
}

// The write half of every mutation, in the one order that cannot lose memory:
// notes to the sidecar first, board to the tracker second. Same doctrine as
// archiveDropped — if the tracker write then fails, the entries are already
// durable and hydrate() dedups the re-append on the next attempt, whereas the
// other order commits a board whose notes were never saved.
async function commitDoc(out, held, notes) {
  const { stripped, lines } = extract(out, notes.keys);
  const appended = await appendNotes(lines);
  const fileRaw = await atomicWrite(stripped, held);
  // The caller is handed the HYDRATED document, byte-identical to what the
  // next readRaw() will serve — the desk PUTs back what it was given.
  return { body: serialize(out), etag: stateEtag(fileRaw, notes.raw + appended) };
}

// Read-modify-write under one lock. `fn` receives the current document and
// returns the replacement, or null/undefined for a deliberate no-op.
export async function mutate(fn, { signal } = {}) {
  return withLock(async (held) => {
    const { doc, notes } = await readRaw();
    const before = serialize(doc);
    // Snapshot the feed BEFORE fn runs: fn gets the live document, and a
    // callback that reassigns doc.feed would otherwise destroy the only record
    // of what was there — the drop diff then compares the new feed to itself
    // and archives nothing while entries vanish. A shallow copy is enough; the
    // diff needs the entries, not protection from in-place edits to them.
    const feedBefore = Array.isArray(doc.feed) ? [...doc.feed] : doc.feed;
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
    // The commit point. Up to here a cancellation costs nothing: the lock is
    // released and the file is untouched. Past the rename inside atomicWrite
    // the write is durable and cancelling it would mean inventing an undo.
    if (signal?.aborted) throw new CancelledError('cancelled before the write was committed');
    // After normalize(), which is itself a trim site — diffing before it would
    // miss exactly the drops the cap causes.
    warnCardLoss(JSON.parse(before).cards, out.cards);
    await archiveDropped(feedBefore, out.feed);
    const { body, etag } = await commitDoc(out, held, notes);
    return { doc: out, body, changed: true, etag };
  }, { signal });
}

// Replace the whole document — the shape PUT /api/tracker needs. Validated
// before the lock so a bad body never contends for it.
//
// `ifMatch` is the etag the caller last read. It is compared INSIDE the lock
// against what is actually on disk, so a caller whose base document has since
// been overtaken is refused rather than silently clobbering the winner. This
// closes the last loss path: the lock alone could not help, because the desk's
// base came from an unlocked GET seconds earlier.
export async function replace(doc, ifMatch) {
  const out = normalize(doc);
  const bad = validate(out);
  if (bad) throw new ValidationError(bad);
  return withLock(async (held) => {
    // Read the current doc even when no ifMatch was given: the incoming body
    // replaces it wholesale, and whatever feed entries it no longer carries are
    // about to be discarded. Without ifMatch a missing or broken tracker just
    // means there is nothing to preserve; WITH ifMatch it stays the error it
    // always was, because an etag cannot match a file that is not there.
    const current = ifMatch !== undefined ? await readRaw() : await readRaw().catch(() => null);
    if (ifMatch !== undefined && current.etag !== ifMatch) {
      throw new ConflictError(
        `tracker changed since you read it (expected ${ifMatch}, found ${current.etag})`,
        current,
      );
    }
    warnCardLoss(current?.doc?.cards, out.cards);
    await archiveDropped(current?.doc?.feed, out.feed);
    // No tracker on disk means nothing to preserve and no sidecar to dedup
    // against — every entry in the incoming body is new.
    const notes = current?.notes || { raw: '', byCard: new Map(), keys: new Set() };
    const { body, etag } = await commitDoc(out, held, notes);
    return { doc: out, body, changed: true, etag };
  });
}
