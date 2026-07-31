// Git audit tests. Run: node --test
//
// The rules are pure, so most of this needs no repository. readGit() is I/O, so
// it gets one real throwaway repo rather than a mock — a mock of git would only
// prove that I can predict git, which is the thing in doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readGit, isOnTrunk, deriveFindings, summarise, driftSince, headState,
  reconcilePlan, CERTAIN, PROPOSED, REPORTED, untrackedMemory,
} from './git.mjs';

const run = promisify(execFile);

const card = (over = {}) => ({
  id: 'SW-001', p: 'shipward', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
  status: 'backlog', claude: null, branch: null, commit: null, note: '',
  created: '2026-07-25T09:00:00Z', pushed: null, shipped: null, ...over,
});

// The shape readGit() produces, built by hand so the rules can be exercised
// without paying for a repository per case.
const facts = (branches = {}) => ({
  ok: true,
  trunk: 'main',
  branches: new Map(Object.entries(branches).map(([name, b]) => [name, {
    name, head: 'aaaaaaa', ahead: 0, merged: false, local: true, ...b,
  }])),
});

const rules = (findings) => findings.map((f) => f.rule);

test('a card claiming it shipped, whose commit never landed', () => {
  const found = deriveFindings(
    [card({ status: 'pushed', commit: 'deadbee', onTrunk: false })], facts(),
  );
  assert.deepEqual(rules(found), ['not-on-trunk']);
  assert.equal(found[0].fix, null, 'the board may be right and the branch rewritten — a human decides');
});

test('a branch with work and no sha recorded on the card', () => {
  // SW-008 carried a null commit for two days.
  const found = deriveFindings(
    [card({ status: 'review', branch: 'fix/thing' })],
    facts({ 'fix/thing': { ahead: 3, head: 'abc1234' } }),
  );
  assert.deepEqual(rules(found), ['missing-commit']);
  assert.deepEqual(found[0].fix, { commit: 'abc1234' });
});

test('work that is on the trunk while the board still has it in flight', () => {
  for (const status of ['claude', 'review']) {
    const found = deriveFindings(
      [card({ status, commit: 'abc1234', branch: 'feat/x', onTrunk: true })],
      facts({ 'feat/x': { ahead: 0, merged: true } }),
    );
    assert.deepEqual(rules(found), ['merged-not-pushed'], status);
    assert.deepEqual(found[0].fix, { status: 'pushed' });
  }
});

test('a freshly cut branch is not mistaken for merged work', () => {
  // The first false positive this tool produced, about the card being written
  // on it: a branch cut from the tip has no commits of its own, so
  // `git branch --merged` lists it, and the old rule read that as "landed".
  const found = deriveFindings(
    [card({ status: 'claude', branch: 'feat/just-started', commit: null, onTrunk: null })],
    facts({ 'feat/just-started': { ahead: 0, merged: true } }),
  );
  assert.deepEqual(rules(found), [], 'no work yet is not the same as work landed');
});

test('a card still in Backlog with commits against its branch', () => {
  // The SW-005 slip: five hundred lines written while the card sat in Backlog.
  const found = deriveFindings(
    [card({ status: 'backlog', branch: 'feat/mcp-server' })],
    facts({ 'feat/mcp-server': { ahead: 12 } }),
  );
  assert.deepEqual(rules(found).sort(), ['missing-commit', 'started-without-saying']);
  assert.ok(found.some((f) => f.fix?.status === 'claude'));
});

test('a card in progress with no branch anywhere', () => {
  const named = deriveFindings([card({ status: 'claude', branch: 'feat/ghost' })], facts());
  assert.deepEqual(rules(named), ['no-branch']);
  assert.match(named[0].git, /feat\/ghost does not exist/);

  const unnamed = deriveFindings([card({ status: 'claude' })], facts());
  assert.deepEqual(rules(unnamed), ['no-branch']);
  assert.equal(unnamed[0].fix, null, 'it may simply not have been created yet');
});

test('a branch the board has never heard of', () => {
  const found = deriveFindings([card({ status: 'backlog' })], facts({
    'feat/nobody-logged-this': { ahead: 4 },
    'chore/empty': { ahead: 0 },
    'personal/scratch': { ahead: 9 },
  }));
  assert.deepEqual(rules(found), ['untracked-branch']);
  assert.match(found[0].git, /feat\/nobody-logged-this/);
  assert.equal(found[0].id, null, 'there is no card to attach it to — that is the point');
});

test('a clean board produces nothing at all', () => {
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'pushed', commit: 'abc1234', branch: 'feat/done', onTrunk: true }),
    card({ id: 'SW-002', status: 'backlog' }),
  ], facts({ 'feat/done': { ahead: 0, merged: true } }));
  assert.deepEqual(found, []);
  assert.equal(summarise(found), 'The board matches git.');
});

test('an unreadable repository yields no findings rather than false ones', () => {
  // "We do not know" must not render as "nothing is wrong".
  assert.deepEqual(deriveFindings([card({ status: 'claude' })], { ok: false, reason: 'nope' }), []);
  assert.deepEqual(deriveFindings([card()], null), []);
});

test('the summary counts each tier separately', () => {
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'review', branch: 'fix/a' }),                 // certain
    card({ id: 'SW-002', status: 'backlog', branch: 'fix/b', commit: 'ccc' }), // proposed
    card({ id: 'SW-003', status: 'pushed', commit: 'dead', onTrunk: false }),  // needs a human
  ], facts({
    'fix/a': { ahead: 1, head: 'bbb2222' },
    'fix/b': { ahead: 2, head: 'ccc3333' },
  }));
  const text = summarise(found);
  assert.match(text, /3 discrepancies/);
  assert.match(text, /1 git can settle on its own/);
  assert.match(text, /1 it can propose/);
  assert.match(text, /1 needing a human/);
});

/* ── the tiers, and what may be written without being asked ── */

test('only the two provable rules are certain', () => {
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'review', branch: 'fix/a' }),                       // missing-commit
    card({ id: 'SW-002', status: 'review', commit: 'abc1234', onTrunk: true }),      // merged-not-pushed
    card({ id: 'SW-003', status: 'backlog', branch: 'fix/c', commit: 'ddd' }),       // started-without-saying
    card({ id: 'SW-004', status: 'pushed', commit: 'dead', onTrunk: false }),        // not-on-trunk
    card({ id: 'SW-005', status: 'claude' }),                                        // no-branch
  ], facts({ 'fix/a': { ahead: 1, head: 'bbb2222' }, 'fix/c': { ahead: 2, head: 'ccc3333' } }));

  const tier = Object.fromEntries(found.map((f) => [f.rule, f.certainty]));
  assert.equal(tier['missing-commit'], CERTAIN);
  assert.equal(tier['merged-not-pushed'], CERTAIN);
  assert.equal(tier['started-without-saying'], PROPOSED);
  assert.equal(tier['not-on-trunk'], REPORTED);
  assert.equal(tier['no-branch'], REPORTED);
});

test('the certain tier is monotonic — nothing in it walks a card backwards', () => {
  // The property that makes writing without being asked safe. not-on-trunk is
  // the only rule that could retract a claim a human made, and it is the one
  // rule deliberately kept out of every writable tier.
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'pushed', commit: 'dead', onTrunk: false }),
  ], facts());
  const { updates, held } = reconcilePlan(found, { level: 'all' });
  assert.deepEqual(updates, [], 'a card is never demoted out of pushed by an audit');
  assert.equal(held.length, 1);
});

test('the plan writes only its level, and says why on the card', () => {
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'review', commit: 'abc1234', onTrunk: true }),
    card({ id: 'SW-002', status: 'backlog', branch: 'fix/c', commit: 'ddd' }),
  ], facts({ 'fix/c': { ahead: 2, head: 'ccc3333' } }));

  const certain = reconcilePlan(found, { level: 'certain', on: '2026-07-28' });
  assert.deepEqual(certain.updates.map((u) => u.id), ['SW-001']);
  assert.deepEqual(certain.held.map((f) => f.rule), ['started-without-saying']);
  assert.match(certain.updates[0].note, /^\[git audit 2026-07-28\] status → pushed —/);
  assert.match(certain.updates[0].note, /The board said review\.$/);

  const all = reconcilePlan(found, { level: 'all' });
  assert.deepEqual(all.updates.map((u) => u.id), ['SW-001', 'SW-002']);
  assert.deepEqual(all.held, []);

  assert.deepEqual(reconcilePlan(found, { level: 'none' }).updates, []);
});

test('a card tripping two rules gets one update carrying both reasons', () => {
  // A backlog card with commits and no sha fires missing-commit AND
  // started-without-saying. Two updates for one id would append the note twice
  // and read like two separate audits.
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'backlog', branch: 'fix/a' }),
  ], facts({ 'fix/a': { ahead: 2, head: 'bbb2222' } }));
  assert.equal(found.length, 2);

  const { updates } = reconcilePlan(found, { level: 'all' });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].rules, ['missing-commit', 'started-without-saying']);
  assert.equal(updates[0].commit, 'bbb2222');
  assert.equal(updates[0].status, 'claude');
  assert.equal(updates[0].note.match(/\[git audit/g).length, 2);
});

/* ── the I/O half, against a real repository ─────────────── */

test('readGit reports the trunk, the branches and what is beyond it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'shipward-git-'));
  const g = (...args) => run('git', args, { cwd: repo });
  try {
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 'test@example.com');
    await g('config', 'user.name', 'Test');
    await writeFile(join(repo, 'a.txt'), 'one');
    await g('add', '-A'); await g('commit', '-qm', 'first');

    await g('checkout', '-qb', 'feat/with-work');
    await writeFile(join(repo, 'b.txt'), 'two');
    await g('add', '-A'); await g('commit', '-qm', 'work');
    const workSha = (await g('rev-parse', '--short', 'HEAD')).stdout.trim();

    await g('checkout', '-q', 'main');
    await g('checkout', '-qb', 'feat/empty');       // cut from the tip, no commits
    await g('checkout', '-q', 'main');

    const facts2 = await readGit(repo);
    assert.equal(facts2.ok, true);
    assert.equal(facts2.trunk, 'main');
    assert.equal(facts2.branches.get('feat/with-work').ahead, 1);
    assert.equal(facts2.branches.get('feat/empty').ahead, 0);
    assert.equal(facts2.branches.has('main'), false, 'the trunk is not one of its own branches');

    assert.equal(await isOnTrunk(workSha, 'main', repo), false, 'not merged yet');
    await g('merge', '-q', '--no-ff', '-m', 'merge', 'feat/with-work');
    assert.equal(await isOnTrunk(workSha, 'main', repo), true, 'merged now');
    assert.equal(await isOnTrunk('0000000', 'main', repo), null, 'an unknown sha is unknown, not false');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a directory that is not a repository says so instead of throwing', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'shipward-nogit-'));
  try {
    const out = await readGit(plain);
    assert.equal(out.ok, false);
    assert.match(out.reason, /not a git repository/);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

/* ── SW-044: how far has the tree moved ──────────────────── */

const stage = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-drift-'));
  const g = (...a) => run('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@t'); await g('config', 'user.name', 'T');
  await writeFile(join(dir, 'a.txt'), '1');
  await g('add', '-A'); await g('commit', '-qm', 'one');
  const first = (await g('rev-parse', '--short', 'HEAD')).stdout.trim();
  return { dir, g, first };
};

test('nothing has landed since HEAD, which is what fresh means', async () => {
  const { dir, first } = await stage();
  try {
    const d = await driftSince([first], dir);
    assert.equal(d[first].known, true);
    assert.equal(d[first].commits, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('drift counts the commits since, and lists what they touched', async () => {
  const { dir, g, first } = await stage();
  try {
    await writeFile(join(dir, 'b.txt'), '2'); await g('add', '-A'); await g('commit', '-qm', 'two');
    await writeFile(join(dir, 'c.txt'), '3'); await g('add', '-A'); await g('commit', '-qm', 'three');
    const d = await driftSince([first], dir);
    assert.equal(d[first].commits, 2);
    assert.deepEqual(d[first].changed.sort(), ['b.txt', 'c.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a sha this repository has never heard of is unknown, not unchanged', async () => {
  const { dir } = await stage();
  try {
    // The failure this guards: a foreign or rebased-away sha answering "0
    // commits since" would render as "still current" — a confident lie.
    const d = await driftSince(['deadbee'], dir);
    assert.equal(d.deadbee.known, false);
    assert.equal(d.deadbee.commits, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('each distinct sha is asked about once, and blanks are dropped', async () => {
  const { dir, first } = await stage();
  try {
    const d = await driftSince([first, first, null, undefined, ''], dir);
    assert.deepEqual(Object.keys(d), [first]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('outside a repository nothing is known, and nothing throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-norepo-'));
  try {
    const d = await driftSince(['abc1234'], dir);
    assert.equal(d.abc1234.known, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ── SW-053: the board is not the code under test ────────── */

test('a modified tracker does not make the tree dirty', async () => {
  const { dir } = await stage();
  try {
    await mkdir(join(dir, '.shipward'), { recursive: true });
    await writeFile(join(dir, '.shipward', 'tracker.json'), '{"version":1}');
    const h = await headState(dir);
    // The heartbeat rewrites this file every 60s. Counting it left every check
    // reporting dirty:true forever — SW-044 rendered one freshness state.
    assert.equal(h.dirty, false, 'a write to the board is not a change to the code the check ran on');
    assert.deepEqual(h.dirtyPaths, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('uncommitted source still counts, which is the whole point of the flag', async () => {
  const { dir } = await stage();
  try {
    await writeFile(join(dir, 'a.txt'), 'changed');
    const h = await headState(dir);
    assert.equal(h.dirty, true);
    assert.deepEqual(h.dirtyPaths, ['a.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an untracked source file counts too', async () => {
  const { dir } = await stage();
  try {
    await writeFile(join(dir, 'new.js'), 'export default 1');
    const h = await headState(dir);
    assert.equal(h.dirty, true);
    assert.deepEqual(h.dirtyPaths, ['new.js']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a staged change counts, and the first path is not mangled', async () => {
  const { dir, g } = await stage();
  try {
    // The parse this replaced read `status --porcelain` by column, and git()
    // trims its output — so the FIRST line lost the leading space of its status
    // field and its path came back with a character missing. One entry, always
    // the first, silently wrong.
    await writeFile(join(dir, 'a.txt'), 'staged');
    await g('add', 'a.txt');
    const h = await headState(dir);
    assert.equal(h.dirty, true);
    assert.deepEqual(h.dirtyPaths, ['a.txt'], 'the path is exact, not off by one');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a board-only change alongside a source change is still dirty', async () => {
  const { dir } = await stage();
  try {
    await mkdir(join(dir, '.shipward'), { recursive: true });
    await writeFile(join(dir, '.shipward', 'tracker.json'), '{}');
    await writeFile(join(dir, 'a.txt'), 'changed');
    const h = await headState(dir);
    assert.equal(h.dirty, true);
    assert.deepEqual(h.dirtyPaths, ['a.txt'], 'the board is filtered out, not the whole check');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* -- the memory has to be IN git (SW-055) ------------------- */

// A repo with a board on disk. `ignored` puts .shipward/notes.jsonl in
// .gitignore, which is the case --exclude-standard would have hidden.
async function repoWithBoard({ commit = false, ignored = false } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'shipward-mem-'));
  const g = (...a) => run('git', a, { cwd: repo });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'test@example.com');
  await g('config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one');
  if (ignored) await writeFile(join(repo, '.gitignore'), '.shipward/notes.jsonl\n');
  await mkdir(join(repo, '.shipward'), { recursive: true });
  await writeFile(join(repo, '.shipward', 'tracker.json'), '{}');
  await writeFile(join(repo, '.shipward', 'notes.jsonl'), '{"card":"SW-001","t":"2026-07-31T00:00:00Z","text":"x"}\n');
  await g('add', '-A');
  await g('commit', '-qm', 'first');
  if (!commit) {
    // Untrack the sidecar but leave it on disk — exactly the state SW-039 left
    // every board in: the file exists, git has never heard of it.
    await g('rm', '-q', '--cached', '.shipward/notes.jsonl').catch(() => {});
    await g('commit', '-qm', 'drop it from the index').catch(() => {});
  }
  return repo;
}

test('an untracked notes.jsonl is reported — it is the memory, and git has never seen it', async () => {
  const repo = await repoWithBoard();
  try {
    const out = await untrackedMemory(repo);
    assert.equal(out.known, true);
    assert.deepEqual(out.files, ['.shipward/notes.jsonl']);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a committed board reports nothing at all', async () => {
  const repo = await repoWithBoard({ commit: true });
  try {
    const out = await untrackedMemory(repo);
    assert.equal(out.known, true);
    assert.deepEqual(out.files, [], 'and so the warning stops firing once it is fixed');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a GITIGNORED notes.jsonl is reported too, which is the worse case', async () => {
  // --exclude-standard would have hidden this one. An ignored memory file is
  // not safer than an untracked one; it is untracked forever and on purpose.
  const repo = await repoWithBoard({ ignored: true });
  try {
    const out = await untrackedMemory(repo);
    assert.deepEqual(out.files, ['.shipward/notes.jsonl']);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('outside a repository it says "we do not know", never "nothing is wrong"', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'shipward-nogit-'));
  try {
    const out = await untrackedMemory(bare);
    assert.equal(out.known, false, 'no claim without git');
    assert.deepEqual(out.files, []);
  } finally { await rm(bare, { recursive: true, force: true }); }
});
