// SW-067 — a first board that is not empty.
//
// The rules are pure, so they are tested without a repository; the one thing
// that needs real git (does the audit actually fill the sha it was left blank
// for?) gets one staged repo at the end, because that claim is the whole point
// and asserting it against a stub would prove nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  SEED_CAP, typeFromBranch, titleFromBranch, seedable, seedCards, seedNote, previewLines,
} from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const NOW = '2026-08-12T10:00:00.000Z';
const br = (name, over = {}) => ({ name, head: 'abc1234', ahead: 1, merged: false, local: true, ...over });

/* ── naming ──────────────────────────────────────────────── */

test('the branch prefix picks the card type, and an unknown one is a feature', () => {
  assert.equal(typeFromBranch('fix/login-crash'), 'bug');
  assert.equal(typeFromBranch('hotfix/thing'), 'bug');
  assert.equal(typeFromBranch('feat/export'), 'feature');
  assert.equal(typeFromBranch('chore/bump'), 'chore');
  assert.equal(typeFromBranch('docs/readme'), 'chore');
  // "some work exists here" is all a bare name supports, and feature is the
  // neutral guess to correct later.
  assert.equal(typeFromBranch('albertos-thing'), 'feature');
  assert.equal(typeFromBranch('WIP/Thing'), 'feature');
});

test('the title is the branch name, not a sentence nobody wrote', () => {
  assert.equal(titleFromBranch('fix/login-crash'), 'Login crash');
  assert.equal(titleFromBranch('feat/csv_export_v2'), 'Csv export v2');
  assert.equal(titleFromBranch('spike'), 'Spike');
  // A trailing slash leaves nothing to title — fall back to the whole ref
  // rather than producing an empty card title the schema would reject.
  assert.equal(titleFromBranch('fix/'), 'fix/');
});

/* ── what deserves a card ────────────────────────────────── */

test('merged branches are finished work and never become backlog', () => {
  const out = seedable([br('feat/live'), br('feat/done', { merged: true })]);
  assert.deepEqual(out.map((b) => b.name), ['feat/live']);
});

test('a ref with nothing ahead of the trunk is not work', () => {
  const out = seedable([br('feat/live'), br('feat/empty', { ahead: 0 })]);
  assert.deepEqual(out.map((b) => b.name), ['feat/live']);
});

test('busiest branch first, ties broken by name so two runs agree', () => {
  const out = seedable([br('b', { ahead: 1 }), br('a', { ahead: 1 }), br('c', { ahead: 9 })]);
  assert.deepEqual(out.map((b) => b.name), ['c', 'a', 'b']);
});

test('seedable tolerates junk in the list rather than throwing on install', () => {
  assert.deepEqual(seedable(null), []);
  assert.deepEqual(seedable([null, undefined, br('ok')]).map((b) => b.name), ['ok']);
});

/* ── the cards ───────────────────────────────────────────── */

const seed = (branches, over = {}) => seedCards(branches, {
  project: 'demo',
  now: NOW,
  nextIdFor: (taken) => `DM-${String(taken.length + 1).padStart(3, '0')}`,
  ...over,
});

test('one backlog card per branch, carrying the branch and nothing invented', () => {
  const { cards } = seed([br('fix/login-crash', { ahead: 2 })]);
  assert.equal(cards.length, 1);
  assert.deepEqual(
    { ...cards[0] },
    {
      id: 'DM-001', p: 'demo', title: 'Login crash', type: 'bug', pri: 'P2', effort: 'M',
      status: 'backlog', claude: null, branch: 'fix/login-crash', commit: null, created: NOW,
    },
  );
});

test('the sha is left null on purpose — it is what makes the audit fire', () => {
  // Not an oversight to be tidied up later: a branch head baked in at install
  // time is stale the next time anyone commits, and "names a branch but records
  // no sha" is the CERTAIN-tier finding that corrects the board in session one.
  const { cards } = seed([br('feat/x'), br('feat/y')]);
  assert.deepEqual(cards.map((c) => c.commit), [null, null]);
  assert.ok(cards.every((c) => c.branch));
});

test('every seeded card validates against the real schema', async () => {
  const schema = JSON.parse(await readFile(join(HERE, '..', '.shipward', 'schema.json'), 'utf8'));
  const spec = schema.properties.cards.items;
  const { cards } = seed([br('fix/a'), br('feat/b'), br('chore/c')]);
  for (const c of cards) {
    for (const key of spec.required) assert.ok(c[key] !== undefined, `${c.id} is missing ${key}`);
    for (const [key, def] of Object.entries(spec.properties)) {
      if (def.enum && c[key] != null) assert.ok(def.enum.includes(c[key]), `${c.id}.${key} = ${c[key]}`);
    }
    assert.match(c.id, /^[A-Z]+-\d{3}$/);
  }
});

test('ids continue the board rather than colliding with it', () => {
  const existing = [{ id: 'DM-007', p: 'demo' }];
  const { cards } = seedCards([br('feat/a'), br('feat/b')], {
    project: 'demo', now: NOW,
    nextIdFor: (taken) => `DM-${String(existing.length + taken.length + 7).padStart(3, '0')}`,
  });
  assert.deepEqual(cards.map((c) => c.id), ['DM-008', 'DM-009']);
});

test('the cap holds and what it drops is reported, never silent', () => {
  const many = Array.from({ length: SEED_CAP + 4 }, (_, i) => br(`feat/b${String(i).padStart(2, '0')}`));
  const { cards, dropped, considered } = seed(many);
  assert.equal(cards.length, SEED_CAP);
  assert.equal(dropped.length, 4);
  assert.equal(considered, SEED_CAP + 4);
  // A truncation nobody mentions reads as full coverage.
  const lines = previewLines({ ok: true, trunk: 'main', branches: many }, { seeded: { cards, dropped } });
  assert.match(lines.join('\n'), /NOT seeded: 4 further branches beyond the cap/);
});

/* ── the note ────────────────────────────────────────────── */

test('the note says it was seeded, and says the guesses are guesses', () => {
  const n = seedNote(br('fix/login-crash', { ahead: 2 }), { known: true, subjects: ['fix the crash'], more: 0 }, NOW);
  assert.equal(n.kind, 'brief');           // nothing was verified — a branch was read
  assert.match(n.text, /SEEDED AT SETUP/);
  assert.match(n.text, /2 commits/);
  assert.match(n.text, /meant to be corrected/);
  assert.match(n.text, /"fix the crash"/);
  assert.match(n.text, /No sha is recorded on purpose/);
});

test('unreadable commit subjects say so instead of implying there were none', () => {
  const n = seedNote(br('feat/x'), { known: false, subjects: [], more: 0 }, NOW);
  assert.match(n.text, /could not be read/);
});

test('a long branch history is summarised, not poured into the board', () => {
  const subjects = Array.from({ length: 12 }, (_, i) => `commit ${i}`);
  const n = seedNote(br('feat/x', { ahead: 40 }), { known: true, subjects, more: 28 }, NOW);
  assert.match(n.text, /\(\+28 more\)/);
  assert.ok(n.text.length < 2000, `note is ${n.text.length} chars`);
});

test('note text carries the card id it was filed under', () => {
  const { cards, notes } = seed([br('feat/x'), br('fix/y')]);
  assert.deepEqual(notes.map((n) => n.card), cards.map((c) => c.id));
  assert.ok(notes.every((n) => n.t === NOW));
});

/* ── the preview ─────────────────────────────────────────── */

test('an unreadable repo says so rather than looking like a repo with no branches', () => {
  const lines = previewLines({ ok: false, reason: 'no main, master or trunk branch' }).join('\n');
  assert.match(lines, /could not be read \(no main, master or trunk branch\)/);
  assert.doesNotMatch(lines, /none with unmerged work/);
});

test('a repo with nothing to seed is told so plainly, not sold a fix', () => {
  const lines = previewLines({ ok: true, trunk: 'main', branches: [br('x', { merged: true })] }, { command: 'CMD' }).join('\n');
  assert.match(lines, /none with unmerged work/);
  assert.match(lines, /Your board starts empty, which is honest/);
  assert.doesNotMatch(lines, /CMD/);      // do not advertise a flag that would do nothing
});

test('without the flag the preview prints the exact command, because an unseen opt-in is the bug', () => {
  const lines = previewLines({ ok: true, trunk: 'main', branches: [br('feat/x')] }, { command: 'node setup.mjs /r --seed-from-branches' }).join('\n');
  assert.match(lines, /node setup\.mjs \/r --seed-from-branches/);
  assert.match(lines, /Nothing is invented/);
});

test('re-running the flag over a fully claimed board explains itself', () => {
  const lines = previewLines({ ok: true, trunk: 'main', branches: [br('feat/x')] },
    { seeded: { cards: [], dropped: [] } }).join('\n');
  assert.match(lines, /Nothing seeded: every branch above is already named by a card/);
  assert.doesNotMatch(lines, /Seeded 0/);
});

test('the preview takes a Map, which is what readGit actually returns', () => {
  const branches = new Map([['feat/x', br('feat/x')]]);
  const lines = previewLines({ ok: true, trunk: 'main', branches }, { command: 'CMD' }).join('\n');
  assert.match(lines, /1 with unmerged work/);
});

test('a long branch list is trimmed on screen and the remainder counted', () => {
  const many = Array.from({ length: 9 }, (_, i) => br(`feat/b${i}`, { ahead: 9 - i }));
  const lines = previewLines({ ok: true, trunk: 'main', branches: many }, { command: 'CMD' }).join('\n');
  assert.match(lines, /9 with unmerged work/);
  assert.match(lines, /…and 4 more/);
});

/* ── against real git ────────────────────────────────────── */

test('end to end: setup seeds a real repo, and the audit then fills the sha it left blank', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-seed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: dir });

  await git('init', '-q', '-b', 'main', '.');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 'T');
  await run('sh', ['-c', 'echo hi > a.txt'], { cwd: dir });
  await git('add', '-A');
  await git('commit', '-qm', 'first');

  await git('checkout', '-q', '-b', 'fix/the-crash');
  await run('sh', ['-c', 'echo x >> a.txt'], { cwd: dir });
  await git('add', '-A');
  await git('commit', '-qm', 'stop the crash');
  await git('checkout', '-q', 'main');

  // A merged branch must be ignored — it is finished work, not backlog.
  await git('checkout', '-q', '-b', 'feat/landed');
  await run('sh', ['-c', 'echo y >> b.txt'], { cwd: dir });
  await git('add', '-A');
  await git('commit', '-qm', 'landed');
  await git('checkout', '-q', 'main');
  await git('merge', '-q', '--no-ff', 'feat/landed', '-m', 'merge');

  await run(process.execPath, [join(HERE, 'setup.mjs'), dir, '--prefix', 'ZZ', '--seed-from-branches'], { cwd: HERE });

  const trackerPath = join(dir, '.shipward', 'tracker.json');
  const board = JSON.parse(await readFile(trackerPath, 'utf8'));
  assert.equal(board.cards.length, 1, 'one card, and not one for the merged branch');
  assert.equal(board.cards[0].branch, 'fix/the-crash');
  assert.equal(board.cards[0].commit, null, 'setup must not bake a branch head');
  assert.equal(board.cards[0].type, 'bug');

  const notes = (await readFile(join(dir, '.shipward', 'notes.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(notes.length, 1);
  assert.equal(JSON.parse(notes[0]).card, board.cards[0].id);
  assert.match(JSON.parse(notes[0]).text, /stop the crash/);

  // The claim this whole design rests on: leaving the sha blank is what lets
  // the certain tier correct the board on the FIRST session, not the tenth.
  const { stdout } = await run(process.execPath, [join(HERE, '..', '.claude', 'hooks', 'shipward.mjs'), 'session-start'], {
    cwd: dir,
    env: { ...process.env, SHIPWARD_TRACKER: trackerPath, SHIPWARD_REPO: dir },
  });
  assert.match(stdout, /the board was corrected/);
  assert.match(stdout, /missing-commit/);

  const after = JSON.parse(await readFile(trackerPath, 'utf8'));
  assert.match(after.cards[0].commit ?? '', /^[0-9a-f]{7,}$/, 'the audit should have filled the sha');
});

test('the note file setup writes ends in a newline, so the next writer cannot collide', async (t) => {
  // SW-068: two hand-appends without this invariant put two JSON objects on one
  // line and the store refused to read it.
  const dir = await mkdtemp(join(tmpdir(), 'shipward-seed-nl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main', '.');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 'T');
  await run('sh', ['-c', 'echo hi > a.txt'], { cwd: dir });
  await git('add', '-A');
  await git('commit', '-qm', 'first');
  await git('checkout', '-q', '-b', 'feat/one');
  await run('sh', ['-c', 'echo x >> a.txt'], { cwd: dir });
  await git('add', '-A');
  await git('commit', '-qm', 'work');
  await git('checkout', '-q', 'main');

  await run(process.execPath, [join(HERE, 'setup.mjs'), dir, '--prefix', 'NL', '--seed-from-branches'], { cwd: HERE });
  const raw = await readFile(join(dir, '.shipward', 'notes.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'notes.jsonl must end in a newline');
  assert.ok(!raw.includes('\n\n'), 'no blank lines');
  for (const line of raw.trim().split('\n')) JSON.parse(line);   // one object per line
});
