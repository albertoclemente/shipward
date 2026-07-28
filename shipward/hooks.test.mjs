// Hook tests. Run: node --test
//
// These spawn the real hook script the way Claude Code does — payload as JSON
// on stdin, response as JSON on stdout — because the contract being tested IS
// that wire shape. A hook that throws, hangs, or prints something unparseable
// degrades the session it was meant to protect.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
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
function run(which, input = {}, env = {}) {
  return new Promise((res) => {
    const child = execFile(
      process.execPath, [HOOK, which],
      { env: { ...process.env, SHIPWARD_TRACKER: tracker, ...env } },
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

test('session-start FIXES what git can prove and only reports the rest', async () => {
  // The SW-024 contract. This card trips two rules at once: the branch has a
  // commit the card does not record (certain — a blank git can fill), and the
  // card says backlog while work exists (proposed — git proves backlog is
  // false but cannot say whether it is claude or review).
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    const { parsed } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    const ctx = parsed.hookSpecificOutput.additionalContext;

    assert.match(ctx, /the board was corrected/, 'it no longer merely reports');
    assert.match(ctx, /missing-commit/, 'the certain half is applied');
    assert.match(ctx, /Still unsettled/);
    assert.match(ctx, /started-without-saying/, 'the SW-005 slip, still surfaced, not written');
    assert.match(ctx, /Claude working \(0\)/, 'and the standup is still there');

    // The claim has to be true on disk, not just in the prose.
    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    const c = onDisk.cards.find((x) => x.id === 'TS-001');
    assert.ok(c.commit, 'the sha git already knew was written to the card');
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

test('the standup describes the board AFTER the reconciler moved it', async () => {
  // Rendering the board and then correcting it in the same breath would hand
  // the session two answers and no way to tell which one is now.
  const repo = await repoWithDrift();
  try {
    const head = (await import('node:child_process')).execFileSync(
      'git', ['rev-parse', '--short', 'feat/mcp-server'], { cwd: repo, encoding: 'utf8' },
    ).trim();
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'review', branch: 'feat/mcp-server', commit: head }),
    ])));
    // main has not moved, so that commit is NOT an ancestor of it yet.
    const { execFile: ex } = await import('node:child_process');
    const sh = (await import('node:util')).promisify(ex);
    await sh('git', ['merge', '--no-ff', '-m', 'merge', 'feat/mcp-server'], { cwd: repo });

    const { parsed } = await run('session-start', {}, { SHIPWARD_REPO: repo });
    const ctx = parsed.hookSpecificOutput.additionalContext;

    assert.match(ctx, /review → pushed/, 'the reconciler moved it');
    assert.match(ctx, /Waiting on you \(0\)/, 'and the standup counts it where it now is');
    assert.doesNotMatch(ctx, /Waiting on you \(1\)/);
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

test('a commit-only correction is not announced as a status change', async () => {
  // The feed line was first built from the status alone, so filling in a
  // missing sha was recorded as "TS-001 → backlog" — a move that never
  // happened, in the log whose whole job is saying what did.
  const repo = await repoWithDrift();
  try {
    await writeFile(tracker, JSON.stringify(seed([
      card({ id: 'TS-001', status: 'backlog', branch: 'feat/mcp-server' }),
    ])));
    await run('session-start', {}, { SHIPWARD_REPO: repo });
    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    assert.match(onDisk.feed[0].msg, /TS-001 commit [0-9a-f]{7}/);
    assert.doesNotMatch(onDisk.feed[0].msg, /→/, 'nothing moved column, so nothing claims to have');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
