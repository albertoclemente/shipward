// Hook tests. Run: node --test
//
// These spawn the real hook script the way Claude Code does — payload as JSON
// on stdin, response as JSON on stdout — because the contract being tested IS
// that wire shape. A hook that throws, hangs, or prints something unparseable
// degrades the session it was meant to protect.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hydrate, parseNotes } from './tracker-store.mjs';
// standup.mjs is pure — board in, words out — so rendering IN process is safe
// where reconciling in process is not (RECONCILE_DIRECTLY below tells that
// story). The SW-057 direct halves lean on this to read the standup with no
// spawn and no clock anywhere in the path.
import { standupText, activeProject } from './standup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// The board as the hooks' own reader sees it: since SW-039 note entries live in
// .shipward/notes.jsonl, so the tracker file on its own shows a board with no
// memory on it.
const boardOnDisk = async (trackerPath) => hydrate(
  JSON.parse(await readFile(trackerPath, 'utf8')),
  parseNotes(await readFile(join(dirname(trackerPath), 'notes.jsonl'), 'utf8').catch(() => '')).byCard,
);
const HOOK = join(ROOT, '.claude', 'hooks', 'shipward.mjs');

let sandbox, tracker;
const sandboxes = [];

const card = (over = {}) => ({
  id: 'TS-001', p: 'test', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
  status: 'backlog', claude: null, branch: null, commit: null, note: '',
  created: '2026-07-25T09:00:00Z', pushed: null, shipped: null, ...over,
});

const seed = (cards = [card()]) => ({
  version: 1,
  activeProject: 'test',
  projects: [{ id: 'test', name: 'Test', tag: 't', prefix: 'TS' }],
  cards,
  feed: [],
});

// Returns { code, out, parsed } — never throws, because the hook must not.
//
// The silencing switches (SW-069) are STRIPPED unless a test asks for one. This
// suite runs on a GitHub runner, where CI=true is already in the environment,
// and inheriting it would make every hook go quiet and every assertion below
// fail for a reason that has nothing to do with the hook. A test that only
// passes on a laptop is not a test.
function run(which, input = {}, env = {}) {
  const base = { ...process.env, SHIPWARD_TRACKER: tracker };
  delete base.CI;
  delete base.GITHUB_ACTIONS;
  delete base.SHIPWARD_HOOKS;
  return new Promise((res) => {
    const child = execFile(
      process.execPath, [HOOK, which],
      { env: { ...base, ...env } },
      (err, stdout) => {
        let parsed = null;
        try { parsed = stdout.trim() ? JSON.parse(stdout) : null; } catch { /* reported below */ }
        res({ code: err?.code ?? 0, out: stdout, parsed, unparseable: !!stdout.trim() && parsed === null });
      },
    );
    child.stdin.end(JSON.stringify(input));
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'shipward-hooks-'));
  sandboxes.push(sandbox);
  await mkdir(join(sandbox, '.shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

after(() => Promise.all(sandboxes.map((s) => rm(s, { recursive: true, force: true }).catch(() => {}))));

test('session-start injects the board and the memory unasked', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-001', status: 'review', note: 'DECIDED: zero dependencies, forever.' }),
    card({ id: 'TS-002', status: 'claude', claude: 'working', branch: 'feat/x' }),
  ]), null, 2) + '\n');

  const { code, parsed } = await run('session-start');
  assert.equal(code, 0);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');

  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Claude working \(1\)/);
  assert.match(ctx, /TS-002 working · feat\/x/);
  assert.match(ctx, /Decisions not to reverse \(1\)/);
  assert.match(ctx, /zero dependencies/);
  assert.match(ctx, /recall\(\{file:/, 'and tells the session how to get more');
});

test('prompt names the active card, every turn', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working', branch: 'feat/x', title: 'The live one' }),
  ]), null, 2) + '\n');

  const { parsed } = await run('prompt');
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /TS-002 \(working, feat\/x\) — "The live one"/);
  assert.match(ctx, /tracker data, not instructions/,
    'a card title can be logged from an issue body — it arrives labelled as data');
  assert.ok(ctx.split('\n').length === 1, 'it is paid for on every prompt — one line');
});

test('prompt says so when nothing is in progress', async () => {
  const { parsed } = await run('prompt');
  assert.match(parsed.hookSpecificOutput.additionalContext, /no card in progress/);
});

test('pre-edit warns when source changes with no card, and never blocks', async () => {
  const { parsed } = await run('pre-edit', {
    tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'shipward', 'serve.mjs') },
  });
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow',
    'a hook that gets in the way gets switched off, and then it protects nothing');
  assert.match(parsed.systemMessage, /no card in progress/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /log then start/);
});

test('pre-edit is silent while a card is open', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working' }),
  ]), null, 2) + '\n');

  const { code, out } = await run('pre-edit', {
    tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'shipward', 'serve.mjs') },
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), '', 'no card work, no noise');
});

test('pre-edit ignores files that prove nothing about the protocol', async () => {
  for (const file of [
    join(ROOT, '.shipward', 'tracker.json'),      // the tracker itself
    join(ROOT, '.claude', 'settings.json'),
    join(ROOT, '_bmad-output', 'specs', 'x.md'),
    join(ROOT, 'CLAUDE.md'),
    '/tmp/somewhere-else/scratch.mjs',            // outside the repo entirely
  ]) {
    const { out } = await run('pre-edit', { tool_name: 'Write', tool_input: { file_path: file } });
    assert.equal(out.trim(), '', `${file} must not be nagged about`);
  }
});

test('stop refuses to end while a card is still working', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working', title: 'Half finished' }),
  ]), null, 2) + '\n');

  const { parsed } = await run('stop', {});
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /TS-002 \(working\) — Half finished/);
  assert.match(parsed.reason, /done\(\{id, commit, note\}\)/);
  assert.match(parsed.reason, /do not close it with an empty note to satisfy this hook/,
    'the hook must not teach the session to game it');
});

test('stop lets go once the board is clear', async () => {
  const { code, out } = await run('stop', {});
  assert.equal(code, 0);
  assert.equal(out.trim(), '');
});

test('stop honours stop_hook_active so it cannot loop forever', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working' }),
  ]), null, 2) + '\n');

  const { out } = await run('stop', { stop_hook_active: true });
  assert.equal(out.trim(), '', 'blocking a second time would refuse the session forever');
});

test('a hook never breaks the session, whatever it is handed', async () => {
  // Rule 1: a broken hook that bricks the project is worse than no hook.
  const missing = { SHIPWARD_TRACKER: join(sandbox, 'nope', 'tracker.json') };
  for (const which of ['session-start', 'prompt', 'pre-edit', 'stop']) {
    const gone = await run(which, {}, missing);
    assert.equal(gone.code, 0, `${which} must survive a missing tracker`);
    assert.equal(gone.out.trim(), '', `${which} must stay quiet about it`);
  }

  await writeFile(tracker, 'this is not json at all');
  for (const which of ['session-start', 'prompt', 'stop']) {
    const broken = await run(which, {});
    assert.equal(broken.code, 0, `${which} must survive an unparseable tracker`);
  }

  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
  const junk = await run('prompt', {});
  assert.equal(junk.code, 0);
  const unknown = await run('not-a-hook', {});
  assert.equal(unknown.code, 0, 'an unknown subcommand is not an error either');
});

test('every hook emits parseable JSON or nothing at all', async () => {
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working', note: 'NEEDS ALBERTO: a decision' }),
  ]), null, 2) + '\n');

  for (const which of ['session-start', 'prompt', 'stop']) {
    const r = await run(which, {});
    assert.equal(r.unparseable, false, `${which} printed something the runtime cannot read`);
  }
});


/* -- after the adversarial review (SW-018) ------------------ */

test('a huge tracker never makes a hook emit truncated JSON', async () => {
  // process.exit() dropped whatever had not flushed — a hard cliff at 64KiB on
  // a pipe. One card with a large title made every hook emit unparseable JSON,
  // and past ~1000 cards the Stop hook's output vanished entirely and it
  // silently stopped blocking. Failing open was the wrong direction.
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-002', status: 'claude', claude: 'working', title: 'x'.repeat(80 * 1024) }),
  ])), 'utf8');

  for (const which of ['session-start', 'prompt', 'stop']) {
    const r = await run(which, {});
    assert.equal(r.code, 0, which + ' exited non-zero');
    assert.equal(r.unparseable, false, which + ' emitted ' + r.out.length + ' bytes of unparseable JSON');
  }
  const stop = await run('stop', {});
  assert.ok(stop.out.trim().length > 0,
    'the Stop hook must not fall silent — silence is how it stops blocking');
});

test('a hook does not wait forever for a stdin that never closes', async () => {
  // With no timeout this stalled every turn until the runtime killed it.
  const child = execFile(process.execPath, [HOOK, 'prompt'],
    { env: { ...process.env, SHIPWARD_TRACKER: tracker } }, () => {});
  child.stdin.write('{}');                      // written, deliberately never ended

  const started = Date.now();
  const code = await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 10000)),
  ]);
  child.kill();
  assert.notEqual(code, 'TIMEOUT', 'still running after ' + (Date.now() - started) + 'ms with stdin held open');
});

test('pre-edit sees a notebook, whose path parameter is not file_path', async () => {
  const { parsed } = await run('pre-edit', {
    tool_name: 'NotebookEdit', tool_input: { notebook_path: join(ROOT, 'shipward', 'analysis.ipynb') },
  });
  assert.equal(parsed?.hookSpecificOutput?.permissionDecision, 'allow');
  assert.match(parsed.systemMessage, /no card in progress/,
    'NotebookEdit was in the matcher but could never warn');
});


/* -- git drift in the session opener (SW-023) --------------- */

// A repository staged with the SW-005 slip: a branch carrying real work while
// the card is still sitting in Backlog.
async function repoWithDrift() {
  const { execFile: ex } = await import('node:child_process');
  const { promisify: p } = await import('node:util');
  const sh = p(ex);
  const repo = await mkdtemp(join(tmpdir(), 'shipward-hookgit-'));
  const g = (...a) => sh('git', a, { cwd: repo });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'test@example.com');
  await g('config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one');
  await g('add', '-A'); await g('commit', '-qm', 'first');
  await g('checkout', '-qb', 'feat/mcp-server');
  await writeFile(join(repo, 'b.txt'), 'two');
  await g('add', '-A'); await g('commit', '-qm', 'work');
  await g('checkout', '-q', 'main');
  return repo;
}

// Drives the reconciler the way the SessionStart hook drives it — same call,
// same `certain` tier, same defaults — with the hook's Promise.race removed, so
// there is no clock anywhere in this path to lose a race to.
//
// In a child process on purpose, and not for tidiness: the store resolves
// SHIPWARD_TRACKER once, at import, and this file has already imported it. An
// in-process reconcile() would take the lock on THIS repo's real board and
// rewrite it — the SW-033 clobber, launched from the test suite. A spawn is the
// only place SHIPWARD_TRACKER can still be pointed at a sandbox.
const mod = (name) => JSON.stringify(pathToFileURL(join(ROOT, 'shipward', name)).href);
const RECONCILE_DIRECTLY = `
import { readRaw } from ${mod('tracker-store.mjs')};
import { activeProject } from ${mod('standup.mjs')};
import { reconcile, describeApplied, summarise } from ${mod('reconcile.mjs')};
const { doc } = await readRaw();
const out = await reconcile(doc.cards, activeProject(doc).id);
process.stdout.write(JSON.stringify({
  ok: out.ok, reason: out.reason, applied: out.applied,
  held: out.held.map((f) => ({ id: f.id, rule: f.rule })),
  described: describeApplied(out.applied), summary: summarise(out.held),
}));
`;

const auditDirectly = (repo) => new Promise((res, rej) => {
  execFile(process.execPath, ['--input-type=module', '-e', RECONCILE_DIRECTLY], {
    cwd: sandbox,
    env: { ...process.env, SHIPWARD_TRACKER: tracker, SHIPWARD_REPO: repo },
  }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stderr}`)) : res(JSON.parse(stdout))));
});

// SW-058. The same child-process rule as RECONCILE_DIRECTLY above — an
// in-process reconcile() would take the lock on THIS repo's real board — with
// the caller's AbortController in the picture, because the thing under test IS
// the cancellation. The abort happens before the call on purpose: aborting
// DURING a reconcile is a bet on where it happens to be when the signal fires,
// and a pre-aborted signal pins the strongest form of the contract — every
// write checkpoint is behind the check, so nothing at all may land.
const RECONCILE_SIGNALLED = `
import { readRaw } from ${mod('tracker-store.mjs')};
import { activeProject } from ${mod('standup.mjs')};
import { reconcile } from ${mod('reconcile.mjs')};
const budget = new AbortController();
if (process.env.SW058_ABORT === '1') budget.abort();
const { doc } = await readRaw();
try {
  const out = await reconcile(doc.cards, activeProject(doc).id, { signal: budget.signal });
  process.stdout.write(JSON.stringify({ settled: 'resolved', ok: out.ok, reason: out.reason, applied: out.applied }));
} catch (err) {
  process.stdout.write(JSON.stringify({ settled: 'rejected', name: err.name }));
}
`;

const reconcileSignalled = (repo, { aborted = false } = {}) => new Promise((res, rej) => {
  execFile(process.execPath, ['--input-type=module', '-e', RECONCILE_SIGNALLED], {
    cwd: sandbox,
    env: { ...process.env, SHIPWARD_TRACKER: tracker, SHIPWARD_REPO: repo, SW058_ABORT: aborted ? '1' : '0' },
  }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stderr}`)) : res(JSON.parse(stdout))));
});

// SW-054 SPLIT THE NEXT TWO TESTS APART, AND THEY MUST STAY APART.
//
// One test used to spawn session-start and assert what the audit had fixed. But
// the hook budgets that audit at AUDIT_BUDGET_MS and renders NOTHING when the
// budget expires — deliberately: a slow repository must never delay a session
// start, and "we do not know" must never read as "nothing is wrong". So
// "assert it fixed something" was secretly an assertion about how busy the
// machine was. It went red once at 7408ms inside a full-suite run, green in
// three runs either side and green alone in ~467ms, with the hook behaving
// exactly as specified the whole time.
//
// Raising the budget was the obvious fix and the wrong one: 2500ms is a
// decision about how long a session start may be delayed, and a test does not
// get to buy itself time out of that. What was actually wrong was asking one
// spawn to prove two unrelated things. So:
//
//   * the hook behaved             — first test, asserting only what holds
//                                    whether or not the audit finished, so load
//                                    cannot make it lie
//   * the audit's output is right  — second test, driven directly with no
//                                    budget in the path at all, so it cannot
//                                    flake and it fails the moment a rule,
//                                    a tier or a written note changes
//
// Do not merge them back into one. A single spawn can only carry both by
// asserting "fixed OR timed out", and an audit that has quietly stopped fixing
// anything satisfies that forever.

test('session-start survives the git audit, however long git takes', async () => {
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const { code, parsed, unparseable } = await run('session-start', {}, { SHIPWARD_REPO: repo });

    // Everything below is true in both worlds — audit finished, audit cut off
    // at the budget — which is what makes this half load-proof rather than
    // load-lucky. Nothing here is conditional on which world we got.
    assert.equal(code, 0);
    assert.equal(unparseable, false);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Claude working \(0\)/, 'the standup arrives — an audit never eats the opener');
    assert.match(ctx, /recall\(\{file:/, 'and so does the rest of it, not a truncated version');

    // The certain tier is monotonic: it fills blanks and confirms landed work,
    // and it never moves a card between columns. That holds whether the audit
    // ran to completion or was cut off mid-write, so it is safe to assert here
    // — and promoting started-without-saying out of `proposed` fails it.
    const c = (await boardOnDisk(tracker)).cards.find((x) => x.id === 'TS-001');
    assert.equal(c.status, 'backlog', 'nothing applied without an explicit ask changes a column');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the audit FIXES what git can prove and only reports the rest', async () => {
  // The SW-024 contract. This card trips two rules at once: the branch has a
  // commit the card does not record (certain — a blank git can fill), and the
  // card says backlog while work exists (proposed — git proves backlog is
  // false but cannot say whether it is claude or review).
  const repo = await repoWithDrift();
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'feat/mcp-server'],
      { cwd: repo, encoding: 'utf8' }).trim();
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));

    const out = await auditDirectly(repo);
    assert.equal(out.ok, true, out.reason || 'the audit ran');
    assert.deepEqual(out.applied.map((a) => a.id), ['TS-001']);
    assert.deepEqual(out.applied[0].rules, ['missing-commit'], 'the certain half, and only that half');
    assert.equal(out.applied[0].commit, head, 'the sha git already knew');
    assert.equal(out.applied[0].was, out.applied[0].to, 'a commit-only fix moves no column');
    assert.deepEqual(out.held.map((f) => f.rule), ['started-without-saying'],
      'the SW-005 slip, surfaced and not written');

    // What a session opener interpolates. The sentences AROUND these live in the
    // hook and can only be read back through a spawn, which is exactly the
    // reading that cost this test its determinism; these are the facts inside
    // them, and they are what a reader acts on.
    assert.match(out.described, new RegExp(`TS-001 commit ${head} \\(missing-commit\\)`));
    assert.match(out.summary, /1 discrepancy .* 1 it can propose/);

    // The claim has to be true on disk, not just in the return value.
    const onDisk = await boardOnDisk(tracker);
    const c = onDisk.cards.find((x) => x.id === 'TS-001');
    assert.equal(c.commit, head, 'the sha git already knew was written to the card');
    assert.equal(c.status, 'backlog', 'the inference was NOT applied — that needs an explicit ask');
    const entry = Array.isArray(c.note) ? c.note[c.note.length - 1] : null;
    assert.ok(entry, 'the correction is a structured entry');
    assert.equal(entry.kind, 'evidence');
    assert.match(entry.text, /\[git audit \d{4}-\d\d-\d\d\] commit → /, 'the card note records why it moved');
    assert.equal(onDisk.feed.length, 1);
    assert.match(onDisk.feed[0].msg, /Reconciled with git/);
    assert.equal(onDisk.feed[0].by, 'claude');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* -- the audit budget is a cancellation, not a curtain (SW-058) */

test('a cancelled reconcile writes nothing — not a byte, not a feed line, not a lock', async () => {
  // The SW-058 contract. The hook's expired budget used to stop only the
  // RENDERING: the raced-and-lost reconcile kept running and could still write
  // the board after the session had been told nothing happened. The write path
  // honours the signal at the two points that matter — before the lock is
  // taken and at the commit point — so an aborted reconcile must leave the
  // tracker byte-identical, with no sidecar and no lock corpse. This board
  // WOULD be corrected without the abort; the plumbing test below proves that
  // with the same seed, so a green here cannot mean "there was nothing to
  // write anyway".
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const before = await readFile(tracker, 'utf8');

    const out = await reconcileSignalled(repo, { aborted: true });
    assert.equal(out.settled, 'rejected', 'cancelled is not a verdict, and must not resolve as one');
    assert.equal(out.name, 'CancelledError');

    assert.equal(await readFile(tracker, 'utf8'), before,
      'byte-identical: an expired budget now means nothing was written, not merely nothing was said');
    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    assert.equal(onDisk.feed.length, 0, 'no feed entry announces work that was cancelled');
    assert.equal(await readFile(join(sandbox, '.shipward', 'notes.jsonl'), 'utf8').catch(() => null), null,
      'no audit note either — the sidecar is part of the board');
    assert.equal(await readFile(`${tracker}.lock`, 'utf8').catch(() => null), null,
      'and no abandoned lock for the next writer to sweep');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('an un-aborted signal changes nothing about a normal reconcile', async () => {
  // The other half of the contract: threading the budget through must cost the
  // normal path nothing. Same seed and same expectations as the un-signalled
  // direct test above, so the two can only drift apart by a real behaviour
  // change — a reconcile that starts treating "a signal exists" as "the signal
  // fired" turns this red.
  const repo = await repoWithDrift();
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'feat/mcp-server'],
      { cwd: repo, encoding: 'utf8' }).trim();
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));

    const out = await reconcileSignalled(repo, { aborted: false });
    assert.equal(out.settled, 'resolved', 'a signal nobody fires is invisible');
    assert.equal(out.ok, true, out.reason || 'the audit ran');
    assert.deepEqual(out.applied.map((a) => a.id), ['TS-001']);

    const onDisk = await boardOnDisk(tracker);
    const c = onDisk.cards.find((x) => x.id === 'TS-001');
    assert.equal(c.commit, head, 'the certain fix landed exactly as it does with no signal at all');
    assert.equal(c.status, 'backlog', 'and moved nothing it would not have moved');
    assert.equal(onDisk.feed.length, 1);
    assert.match(onDisk.feed[0].msg, /Reconciled with git/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

// SW-057: THE SAME SPLIT AS SW-054 ABOVE, for the two remaining tests that
// still rode the audit budget — this pair, and the commit-only pair further
// down. Each spawned session-start and asserted an artifact only a COMPLETED
// audit produces (the moved card in the standup; the feed line's wording), and
// measured under load, 5 of 20 session-start spawns do not finish the audit
// inside AUDIT_BUDGET_MS. A 25% bet is not a test. Same cure, same doctrine,
// same warning about merging the halves back — and one thing SW-054 could not
// yet say: since SW-058 an expired budget ABORTS the reconcile and mutate
// refuses to commit past the abort, so the spawn halves' invariant got
// STRONGER. There is no longer a world where the audit timed out and its write
// landed anyway behind the rendered silence — timed out means nothing written,
// and a board that moved without its feed line (or the reverse) is a torn
// write in ANY world, which is exactly what the spawn halves pin.

// The promotion scenario both halves of the standup pair need: a review card
// whose commit main has since absorbed — the one column move the certain tier
// may make on its own.
async function repoWithMergedWork() {
  const repo = await repoWithDrift();
  const head = execFileSync('git', ['rev-parse', '--short', 'feat/mcp-server'],
    { cwd: repo, encoding: 'utf8' }).trim();
  await writeFile(tracker, JSON.stringify(seed([
    card({ id: 'TS-001', status: 'review', branch: 'feat/mcp-server', commit: head }),
  ])));
  const { execFile: ex } = await import('node:child_process');
  const sh = (await import('node:util')).promisify(ex);
  await sh('git', ['merge', '--no-ff', '-m', 'merge', 'feat/mcp-server'], { cwd: repo });
  return { repo, head };
}

test('session-start hands the board back whole, whether or not the audit finished', async () => {
  const { repo, head } = await repoWithMergedWork();
  try {
    const { code, parsed, unparseable } = await run('session-start', {}, { SHIPWARD_REPO: repo });

    // True in both worlds, like the SW-054 half above: the opener arrives
    // intact however the race went.
    assert.equal(code, 0);
    assert.equal(unparseable, false);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Claude working \(0\)/, 'the standup arrives — an audit never eats the opener');
    assert.match(ctx, /recall\(\{file:/, 'all of it, not a truncated version');

    // The board is wherever the race left it, but never anywhere ELSE and
    // never half-moved. review → pushed is the only move the certain tier may
    // make here; a third status means the audit invented a column.
    const onDisk = await boardOnDisk(tracker);
    const c = onDisk.cards.find((x) => x.id === 'TS-001');
    assert.ok(c.status === 'review' || c.status === 'pushed',
      `the audit may only confirm review → pushed, never invent a column (got ${c.status})`);
    assert.equal(c.commit, head, 'the sha survives either world untouched');
    // Whole or not at all: the correction and the feed line that announces it
    // land in ONE mutate, cancelled before the commit point or not at all, so
    // seeing exactly one of them — in either direction — is a torn write, and
    // no amount of load may produce one.
    assert.equal(onDisk.feed.some((f) => /Reconciled with git/.test(f.msg)), c.status === 'pushed',
      'the move and its announcement are one write');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the standup describes the board AFTER the reconciler moved it', async () => {
  // Rendering the board and then correcting it in the same breath would hand
  // the session two answers and no way to tell which one is now. Driven
  // directly — no budget anywhere in the path — and then rendered through
  // standupText, which is what the hook itself interpolates: the same words,
  // minus the clock that made asserting them a bet on machine load.
  const { repo } = await repoWithMergedWork();
  try {
    const out = await auditDirectly(repo);
    assert.equal(out.ok, true, out.reason || 'the audit ran');
    assert.match(out.described, /TS-001 review → pushed/, 'the reconciler moved it, and says so');

    const doc = await boardOnDisk(tracker);
    assert.equal(doc.cards.find((x) => x.id === 'TS-001').status, 'pushed',
      'moved on disk, not merely in the return value');
    const textNow = standupText(doc, activeProject(doc));
    assert.match(textNow, /Waiting on you \(0\)/, 'and the standup counts it where it now is');
    assert.doesNotMatch(textNow, /Waiting on you \(1\)/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('session-start says nothing about git when the board matches', async () => {
  // The drift repo is NOT clean for this purpose: its feature branch carries
  // work no card claims, which is a finding in its own right. Correctly so —
  // the first version of this test asserted otherwise and was simply wrong.
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'claude', claude: 'working', branch: 'feat/mcp-server', commit: 'ffffff0' }),
    ])));
    const { parsed } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /started-without-saying|untracked-branch|no-branch/,
      'a board that matches git earns no drift paragraph');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('an unreadable repository is silence, never a false all-clear', async () => {
  // "We do not know" must not render as "nothing is wrong".
  const plain = await mkdtemp(join(tmpdir(), 'shipward-nogit-'));
  try {
    await writeFile(tracker, JSON.stringify(seed([card({ id: 'TS-001', status: 'backlog' })])));
    const { code, parsed } = await run('session-start', {}, { SHIPWARD_REPO: plain });
    assert.equal(code, 0);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /disagree/);
    assert.doesNotMatch(ctx, /matches git/, 'it must not claim the board is clean either');
    assert.match(ctx, /Claude working/, 'and the standup still arrives');
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test('the audit runs only at session start, never on a per-turn hook', async () => {
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const { parsed } = await run('prompt', {}, { SHIPWARD_REPO: repo });
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /disagree/,
      'the prompt hook is paid for on every turn — it stays one line');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// SW-057, the second pair — same split, same doctrine as the block above the
// merged-work pair. The original spawned session-start and then read
// onDisk.feed[0], an entry only a COMPLETED audit writes: under load feed[0]
// was simply undefined and the test went red on the machine's schedule, not
// on a bug.

test('the feed claims no move, whether or not the audit finished', async () => {
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const { code, unparseable } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    assert.equal(code, 0);
    assert.equal(unparseable, false);

    // Since SW-058 there are exactly two boards this spawn can leave —
    // corrected whole, or untouched — and everything below holds on both.
    const onDisk = await boardOnDisk(tracker);
    const c = onDisk.cards.find((x) => x.id === 'TS-001');
    assert.equal(c.status, 'backlog', 'a commit-only fix moves no column, finished or cancelled');
    for (const f of onDisk.feed) {
      assert.doesNotMatch(f.msg, /→/, 'no feed line ever claims a move this board did not make');
    }
    assert.equal(onDisk.feed.length > 0, c.commit != null,
      'the filled sha and the feed line announcing it are one write — seeing only one of them is a torn write');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a commit-only correction is not announced as a status change', async () => {
  // The feed line was first built from the status alone, so filling in a
  // missing sha was recorded as "TS-001 → backlog" — a move that never
  // happened, in the log whose whole job is saying what did. Driven directly
  // so the entry ALWAYS exists to be read — the spawn half above can only
  // prove nobody lies on the boards a race happens to leave behind.
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const out = await auditDirectly(repo);
    assert.equal(out.ok, true, out.reason || 'the audit ran');
    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    assert.equal(onDisk.feed.length, 1, 'the correction was announced');
    assert.match(onDisk.feed[0].msg, /TS-001 commit [0-9a-f]{7}/);
    assert.doesNotMatch(onDisk.feed[0].msg, /→/, 'nothing moved column, so nothing claims to have');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* -- the memory has to be IN git (SW-055) ------------------- */

// A repo whose board is on disk with the sidecar left untracked — the state
// SW-039 put every board in the moment it migrated.
async function repoWithLooseMemory({ commit = false } = {}) {
  const { execFile: ex } = await import('node:child_process');
  const { promisify: p } = await import('node:util');
  const sh = p(ex);
  const repo = await mkdtemp(join(tmpdir(), 'shipward-hookmem-'));
  const g = (...a) => sh('git', a, { cwd: repo });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'test@example.com');
  await g('config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one');
  await mkdir(join(repo, '.shipward'), { recursive: true });
  await writeFile(join(repo, '.shipward', 'notes.jsonl'), '{"card":"TS-001","t":"2026-07-31T00:00:00Z","text":"x"}\n');
  await g('add', '-A');
  await g('commit', '-qm', 'first');
  if (!commit) {
    await g('rm', '-q', '--cached', '.shipward/notes.jsonl');
    await g('commit', '-qm', 'untrack it');
  }
  return repo;
}

test('session-start says so when the memory is not in git, and how to fix it', async () => {
  const repo = await repoWithLooseMemory();
  try {
    const { parsed, code } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /Not in git: \.shipward\/notes\.jsonl/);
    assert.match(ctx, /invisible to `git commit -a`/, 'says WHY it is easy to miss');
    assert.match(ctx, /git add \.shipward\/notes\.jsonl/, 'and hands over the exact command');
    assert.match(ctx, /Claude working/, 'and the standup is still there — this is an addition, not a takeover');
    assert.equal(code, 0, 'a warning never fails the session');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('session-start is silent about the memory once it is committed', async () => {
  // The warning has to stop. One that fires every session is one a reader
  // learns to skip, and a skipped warning protects nothing (SW-015).
  const repo = await repoWithLooseMemory({ commit: true });
  try {
    const { parsed } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.doesNotMatch(ctx, /Not in git/);
    assert.match(ctx, /Claude working/, 'the standup is unaffected');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a repo with no board at all is not nagged about a file it never had', async () => {
  const repo = await repoWithDrift();               // real repo, no .shipward/ in it
  try {
    const { parsed } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    assert.doesNotMatch(parsed?.hookSpecificOutput?.additionalContext ?? '', /Not in git/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

/* ── silent under CI (SW-069) ────────────────────────────── */

// The `stop` hook refuses to end a session while a card is claude/working. On a
// runner that is a false positive by construction — the working card belongs to
// somebody's local session, the runner started nothing and has nothing to hand
// back — so a Claude-in-CI job would be told it may not stop. Verified against
// the real board before this existed: decision:block, naming a card a human was
// holding.
//
// This is not the guard being switched off. `done` still runs the check in CI
// and the git audit still corrects the board; what stops is the nagging.

const working = () => [card({ status: 'claude', claude: 'working' })];

for (const [label, env] of [
  ['CI=true', { CI: 'true' }],
  ['GITHUB_ACTIONS=true', { GITHUB_ACTIONS: 'true' }],
  ['SHIPWARD_HOOKS=off', { SHIPWARD_HOOKS: 'off' }],
]) {
  test(`every hook is silent under ${label}`, async () => {
    await writeFile(tracker, JSON.stringify(seed(working()), null, 2) + '\n');
    for (const which of ['session-start', 'prompt', 'pre-edit', 'stop']) {
      const r = await run(which, { tool_input: { file_path: join(ROOT, 'shipward', 'lib.js') } }, env);
      assert.equal(r.code, 0, `${which} must still exit 0`);
      assert.equal(r.out.trim(), '', `${which} spoke under ${label}: ${r.out.slice(0, 120)}`);
    }
  });
}

test('stop still blocks when none of the switches is set', async () => {
  // The other half of the pair: a guard that is always silent is not a guard,
  // and this is what proves the CI cases above are the exception.
  await writeFile(tracker, JSON.stringify(seed(working()), null, 2) + '\n');
  const r = await run('stop');
  assert.equal(r.parsed?.decision, 'block');
  assert.match(r.parsed.reason, /TS-001/);
});

test('CI is only honoured as the literal "true", not any truthy string', async () => {
  // `CI=false` is set by some tooling, and treating it as "in CI" would silence
  // the hooks on a developer's machine — the exact place they are wanted.
  await writeFile(tracker, JSON.stringify(seed(working()), null, 2) + '\n');
  for (const value of ['false', '0', '']) {
    const r = await run('stop', {}, { CI: value });
    assert.equal(r.parsed?.decision, 'block', `CI=${JSON.stringify(value)} should not silence the hook`);
  }
});
