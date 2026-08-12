// SW-068 — the sidecar cannot be corrupted by an append, and there is a
// first-class way to write a note so nobody has a reason to hand-append.
//
// The incident: two hand appends of the form appendFileSync('\n' + obj) against
// a file that already ended in a newline left a blank line AND no trailing one,
// so the next writer's object landed on the previous line. `{…}{…}` parses as
// nothing, so BOTH entries were invisible to every reader while sitting intact
// on disk — memory loss caused by a missing byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { splitObjects, parseNotes } from './tracker-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const CLI = join(HERE, 'cli.mjs');

const entry = (card, t, text) => JSON.stringify({ card, t, kind: 'finding', text });

/* ── splitting a shared line ─────────────────────────────── */

test('two objects on one line are split back apart', () => {
  const parts = splitObjects('{"a":1}{"b":2}');
  assert.deepEqual(parts, ['{"a":1}', '{"b":2}']);
});

test('a brace inside note prose cannot split an entry', () => {
  // This is the case a naive split on `}{` gets wrong, and note text is exactly
  // where a stray brace lives — people paste code into notes.
  const a = JSON.stringify({ card: 'A', t: 'x', text: 'the fix was }{ in the parser' });
  const b = JSON.stringify({ card: 'B', t: 'y', text: 'and }{ again here' });
  const parts = splitObjects(a + b);
  assert.deepEqual(parts.map((p) => JSON.parse(p).card), ['A', 'B']);
});

test('an escaped quote does not end the string scan', () => {
  const a = JSON.stringify({ card: 'A', t: 'x', text: 'he said "}{" loudly' });
  const b = JSON.stringify({ card: 'B', t: 'y', text: 'ok' });
  assert.deepEqual(splitObjects(a + b).map((p) => JSON.parse(p).card), ['A', 'B']);
});

test('a single object is not a recovery, and genuine corruption is not guessed at', () => {
  // Returning [] here is what keeps a truly broken line REPORTED rather than
  // silently reinterpreted.
  assert.deepEqual(splitObjects('{"a":1}'), []);
  assert.deepEqual(splitObjects('{"a":1'), []);
  assert.deepEqual(splitObjects('not json at all'), []);
  assert.deepEqual(splitObjects('}{'), []);
});

/* ── the reader recovers rather than drops ───────────────── */

test('entries sharing a line are recovered, not lost', () => {
  const raw = [entry('SW-1', '2026-01-01T00:00:00.000Z', 'first'),
    entry('SW-2', '2026-01-02T00:00:00.000Z', 'second') + entry('SW-3', '2026-01-03T00:00:00.000Z', 'third')].join('\n');
  const { byCard, recovered } = parseNotes(raw);
  assert.equal(recovered, 2);
  assert.deepEqual([...byCard.keys()].sort(), ['SW-1', 'SW-2', 'SW-3']);
  assert.equal(byCard.get('SW-3')[0].text, 'third');
});

test('recovery is announced on stderr — the file on disk is still malformed', () => {
  const raw = entry('SW-1', '2026-01-01T00:00:00.000Z', 'a') + entry('SW-2', '2026-01-02T00:00:00.000Z', 'b');
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try { parseNotes(raw); } finally { process.stderr.write = real; }
  assert.match(written.join(''), /recovered 2 entries/);
  assert.match(written.join(''), /one object per line/);
});

test('a blank line is still not an error, and a truly bad line is still counted', () => {
  const raw = ['', entry('SW-1', '2026-01-01T00:00:00.000Z', 'a'), '', 'GARBAGE', ''].join('\n');
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  let out;
  try { out = parseNotes(raw); } finally { process.stderr.write = real; }
  assert.equal(out.recovered, 0);
  assert.equal(out.byCard.get('SW-1').length, 1);
  assert.match(written.join(''), /skipped 1 unreadable line/);
});

/* ── the append cannot glue itself to a bad last line ────── */

const stagedBoard = async (t, notesRaw) => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-note-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.shipward'), { recursive: true });
  const tracker = {
    version: 1, activeProject: 'p', rev: 0,
    projects: [{ id: 'p', name: 'P', tag: 't', prefix: 'PP' }],
    cards: [{
      id: 'PP-001', p: 'p', title: 'A card', type: 'chore', pri: 'P2', effort: 'S',
      status: 'backlog', claude: null, branch: null, commit: null,
      created: '2026-01-01T00:00:00.000Z',
    }],
    feed: [],
  };
  await writeFile(join(dir, '.shipward', 'tracker.json'), JSON.stringify(tracker, null, 2) + '\n');
  if (notesRaw !== null) await writeFile(join(dir, '.shipward', 'notes.jsonl'), notesRaw);
  return {
    dir,
    notes: join(dir, '.shipward', 'notes.jsonl'),
    env: {
      ...process.env,
      SHIPWARD_TRACKER: join(dir, '.shipward', 'tracker.json'),
      SHIPWARD_NOTES: join(dir, '.shipward', 'notes.jsonl'),
      SHIPWARD_REPO: dir,
    },
  };
};

test('appending after a file with NO trailing newline does not glue two objects together', async (t) => {
  // The exact shape of the incident.
  const b = await stagedBoard(t, entry('PP-001', '2026-01-01T00:00:00.000Z', 'left unterminated'));
  await run(process.execPath, [CLI, 'note', 'PP-001', 'the second entry'], { env: b.env });
  const raw = await readFile(b.notes, 'utf8');
  assert.ok(raw.endsWith('\n'), 'must end in a newline');
  assert.ok(!raw.includes('}{'), 'must not glue two objects onto one line');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('appending to a normal file adds no blank line', async (t) => {
  const b = await stagedBoard(t, entry('PP-001', '2026-01-01T00:00:00.000Z', 'fine') + '\n');
  await run(process.execPath, [CLI, 'note', 'PP-001', 'second'], { env: b.env });
  const raw = await readFile(b.notes, 'utf8');
  assert.ok(!raw.includes('\n\n'), 'no blank lines');
  assert.equal(raw.trim().split('\n').length, 2);
});

test('the first note on a repo with no sidecar yet does not open with a blank line', async (t) => {
  const b = await stagedBoard(t, null);
  await run(process.execPath, [CLI, 'note', 'PP-001', 'the very first thing known'], { env: b.env });
  const raw = await readFile(b.notes, 'utf8');
  assert.ok(!raw.startsWith('\n'), 'must not lead with a separator');
  assert.equal(raw.trim().split('\n').length, 1);
  assert.equal(JSON.parse(raw.trim()).text, 'the very first thing known');
});

/* ── the tool itself ─────────────────────────────────────── */

test('note writes to the memory and leaves the board alone', async (t) => {
  const b = await stagedBoard(t, null);
  const { stdout } = await run(process.execPath, [CLI, 'note', 'PP-001', 'decided not to cache it', '--kind', 'decision'], { env: b.env });
  // The reply must say what it did NOT do, or "noted" reads as "moved".
  assert.match(stdout, /Status is unchanged \(backlog\)/);
  assert.match(stdout, /memory, not the board/);

  const board = JSON.parse(await readFile(join(b.dir, '.shipward', 'tracker.json'), 'utf8'));
  assert.equal(board.cards[0].status, 'backlog');
  assert.equal(board.cards[0].claude, null);
  assert.equal(board.feed.length, 1, 'a write still earns a feed entry');
  assert.match(board.feed[0].msg, /PP-001 note/);

  const written = JSON.parse((await readFile(b.notes, 'utf8')).trim());
  assert.equal(written.card, 'PP-001');
  assert.equal(written.kind, 'decision');
  assert.equal(written.text, 'decided not to cache it');
});

test('note can be recalled straight back, which is the only thing that matters', async (t) => {
  const b = await stagedBoard(t, null);
  await run(process.execPath, [CLI, 'note', 'PP-001', 'the lock is held across the whole write'], { env: b.env });
  const { stdout } = await run(process.execPath, [CLI, 'recall', 'lock'], { env: b.env });
  assert.match(stdout, /held across the whole write/);
});

test('note refuses an unknown card and an empty entry', async (t) => {
  const b = await stagedBoard(t, null);
  await assert.rejects(
    () => run(process.execPath, [CLI, 'note', 'PP-999', 'text'], { env: b.env }),
    (e) => /no card PP-999/.test(e.stderr) && e.code === 1,
  );
  await assert.rejects(
    () => run(process.execPath, [CLI, 'note', 'PP-001', '   '], { env: b.env }),
    (e) => /needs text/.test(e.stderr) && e.code === 1,
  );
  // Neither mistake may leave a partial write behind.
  await assert.rejects(() => readFile(b.notes, 'utf8'), { code: 'ENOENT' });
});

test('two notes in a row stay two readable lines', async (t) => {
  const b = await stagedBoard(t, null);
  await run(process.execPath, [CLI, 'note', 'PP-001', 'first thing'], { env: b.env });
  await run(process.execPath, [CLI, 'note', 'PP-001', 'second thing'], { env: b.env });
  const raw = await readFile(b.notes, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).text), ['first thing', 'second thing']);
  assert.ok(raw.endsWith('\n'));
});

test('the feed line is a glance, not the whole note', async (t) => {
  const b = await stagedBoard(t, null);
  const long = 'a '.repeat(200) + 'end';
  await run(process.execPath, [CLI, 'note', 'PP-001', long], { env: b.env });
  const board = JSON.parse(await readFile(join(b.dir, '.shipward', 'tracker.json'), 'utf8'));
  assert.ok(board.feed[0].msg.length < 90, `feed line is ${board.feed[0].msg.length} chars`);
  assert.match(board.feed[0].msg, /…$/);
  // …while the entry itself is untouched.
  assert.equal(JSON.parse((await readFile(b.notes, 'utf8')).trim()).text, long);
});
