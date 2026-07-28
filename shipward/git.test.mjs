// Git audit tests. Run: node --test
//
// The rules are pure, so most of this needs no repository. readGit() is I/O, so
// it gets one real throwaway repo rather than a mock — a mock of git would only
// prove that I can predict git, which is the thing in doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGit, isOnTrunk, deriveFindings, summarise } from './git.mjs';

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

test('the summary counts what can actually be applied', () => {
  const found = deriveFindings([
    card({ id: 'SW-001', status: 'review', branch: 'fix/a' }),          // fixable
    card({ id: 'SW-002', status: 'pushed', commit: 'dead', onTrunk: false }), // needs a human
  ], facts({ 'fix/a': { ahead: 1, head: 'bbb2222' } }));
  assert.match(summarise(found), /2 discrepancies .*, 1 of them applicable automatically/);
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
