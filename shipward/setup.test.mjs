// Onboarding tests. Run: node --test
//
// setup.mjs writes into a TARGET repo, so every test stages a throwaway git
// repo and runs the real script against it — the contract is the files it
// leaves behind, and only the files can prove it.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, 'setup.mjs');

let repo;
const repos = [];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'shipward-setup-'));
  repos.push(repo);
  await run('git', ['init', '-q'], { cwd: repo });
});
after(() => Promise.all(repos.map((r) => rm(r, { recursive: true, force: true }).catch(() => {}))));

const setup = (...extra) => run(process.execPath, [SETUP, repo, ...extra]);
const json = async (rel) => JSON.parse(await readFile(join(repo, rel), 'utf8'));

test('one run wires tracker, schema, hooks, statusline, mcp and CLAUDE.md', async () => {
  const { stdout } = await setup('--name', 'Catch', '--prefix', 'CA');
  assert.match(stdout, /wired/);

  const tracker = await json('.shipward/tracker.json');
  assert.equal(tracker.projects[0].prefix, 'CA');
  assert.equal(tracker.projects[0].name, 'Catch');
  assert.equal(tracker.cards.length, 0);
  assert.equal(tracker.feed.length, 1, 'the onboarding is the first feed entry');

  const { validate } = await import('./tracker-store.mjs');
  assert.equal(validate(tracker), null, 'the seeded tracker passes the same validation every write does');

  const settings = await json('.claude/settings.json');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const cmds = settings.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes('shipward.mjs')), `${ev} wired`);
    assert.ok(cmds.some((c) => c.includes('SHIPWARD_TRACKER="$CLAUDE_PROJECT_DIR')), `${ev} points at the TARGET tracker`);
  }
  assert.match(settings.statusLine.command, /status\.mjs/);

  const mcp = await json('.mcp.json');
  assert.equal(mcp.mcpServers.shipward.env.SHIPWARD_REPO, repo);
  assert.ok(mcp.mcpServers.shipward.env.SHIPWARD_TRACKER.endsWith('.shipward/tracker.json'));

  const md = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
  assert.match(md, /shipward-protocol/);
  assert.match(md, /standup/);
});

test('a second run changes nothing', async () => {
  await setup();
  const before = await Promise.all(['.shipward/tracker.json', '.claude/settings.json', '.mcp.json', 'CLAUDE.md']
    .map((f) => readFile(join(repo, f), 'utf8')));
  const { stdout } = await setup();
  assert.match(stdout, /^ {2}kept/m);
  // The report's action lines start with "  wired" — the word also appears
  // inside kept-messages ("already wired"), so anchor on the column.
  assert.doesNotMatch(stdout, /^ {2}wired/m);
  const afterFiles = await Promise.all(['.shipward/tracker.json', '.claude/settings.json', '.mcp.json', 'CLAUDE.md']
    .map((f) => readFile(join(repo, f), 'utf8')));
  assert.deepEqual(afterFiles, before, 'idempotent means byte-identical');
});

test('existing settings, mcp servers and CLAUDE.md are preserved, never clobbered', async () => {
  await mkdir(join(repo, '.claude'), { recursive: true });
  await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo mine' },
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-stop' }] }] },
  }, null, 2));
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2));
  await writeFile(join(repo, 'CLAUDE.md'), '# My project\n\nRules of the house.\n');

  await setup();
  const settings = await json('.claude/settings.json');
  assert.equal(settings.statusLine.command, 'echo mine', 'an existing statusline wins');
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  const stopCmds = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCmds.includes('echo my-stop'), 'the existing Stop hook survives');
  assert.ok(stopCmds.some((c) => c.includes('shipward.mjs')), 'and Shipward is added beside it');

  const mcp = await json('.mcp.json');
  assert.ok(mcp.mcpServers.other, 'other servers survive');
  assert.ok(mcp.mcpServers.shipward);

  const md = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# My project/, 'existing content leads');
  assert.match(md, /shipward-protocol/, 'protocol appended after it');
});

test('refuses a non-git directory and a nonsense prefix, touching nothing', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'shipward-nogit-'));
  repos.push(plain);
  await assert.rejects(run(process.execPath, [SETUP, plain]), /not a git repository/);
  await assert.rejects(setup('--prefix', '42'), /prefix must be letters/);
  await assert.rejects(run(process.execPath, [SETUP]), /usage:/);
});

test('the onboarded repo resolves from inside itself — cwd, no env', async () => {
  // The whole point of the central-install design: standing in the repo is
  // enough. A child process with NO SHIPWARD_* env, cwd'd into the target,
  // must read the target's tracker, not the central one.
  await setup('--name', 'Elsewhere', '--prefix', 'EW');
  const env = { ...process.env };
  delete env.SHIPWARD_TRACKER;
  delete env.SHIPWARD_REPO;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import { readRaw, TRACKER } from ${JSON.stringify(join(HERE, 'tracker-store.mjs'))};
    const { doc } = await readRaw();
    console.log(JSON.stringify({ tracker: TRACKER, project: doc.projects[0].name }));
  `], { cwd: repo, env });
  const out = JSON.parse(stdout);
  assert.equal(out.project, 'Elsewhere');
  // realpath both sides: macOS spells the temp dir /var/… in the test and
  // /private/var/… in the child's cwd — one directory, two names.
  const { realpath } = await import('node:fs/promises');
  assert.equal(await realpath(out.tracker), await realpath(join(repo, '.shipward', 'tracker.json')));
});

/* ── a moved install is repaired, not reported as fine (SW-066) ── */

const CENTRAL = join(HERE, '..');
const GONE = '/nonexistent/old-shipward';
const WIRED = ['.claude/settings.json', '.mcp.json', 'CLAUDE.md'];

// Rewrite every reference to this install so the repo looks like one onboarded
// from an install that has since been moved, renamed or reinstalled.
const moveInstall = async () => {
  for (const f of WIRED) {
    const p = join(repo, f);
    await writeFile(p, (await readFile(p, 'utf8')).split(CENTRAL).join(GONE), 'utf8');
  }
};
const stale = async () => {
  let n = 0;
  for (const f of WIRED) n += (await readFile(join(repo, f), 'utf8')).split(GONE).length - 1;
  return n;
};

test('re-running setup repairs wiring that points at a vanished install', async () => {
  // The bug this closes: idempotent by PRESENCE meant a second run saw a
  // shipward hook, said "already wired" and changed nothing — so the repo kept
  // four hooks pointing at a path that no longer existed. The hooks exit
  // silently on any error by design, which is what made it invisible.
  await setup('--prefix', 'CA');
  await moveInstall();
  assert.ok(await stale() > 0, 'the fixture must actually be stale');

  const { stdout } = await setup();
  assert.equal(await stale(), 0, 'no reference to the old install may survive');
  assert.match(stdout, /repointed at this install/);

  const settings = await json('.claude/settings.json');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const cmds = settings.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.every((c) => !c.includes(GONE)), `${ev} still names the old install`);
    assert.ok(cmds.some((c) => c.includes(CENTRAL)), `${ev} was not repointed here`);
  }
  assert.ok(settings.statusLine.command.includes(CENTRAL));
  assert.equal((await json('.mcp.json')).mcpServers.shipward.args[0], join(CENTRAL, 'shipward', 'mcp.mjs'));
  assert.ok((await readFile(join(repo, 'CLAUDE.md'), 'utf8')).includes(CENTRAL));
});

test('a repair does not duplicate the hooks it repairs', async () => {
  await setup('--prefix', 'CA');
  await moveInstall();
  await setup();
  const settings = await json('.claude/settings.json');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const cmds = settings.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command))
      .filter((c) => c.includes('shipward'));
    assert.equal(cmds.length, 1, `${ev} should hold one shipward hook, has ${cmds.length}`);
  }
});

test('a clean re-run still changes nothing at all', async () => {
  // The other half: repairing on a mismatch must not make every run a rewrite.
  await setup('--prefix', 'CA');
  const before = await Promise.all(WIRED.map((f) => readFile(join(repo, f), 'utf8')));
  const { stdout } = await setup();
  const after = await Promise.all(WIRED.map((f) => readFile(join(repo, f), 'utf8')));
  assert.deepEqual(after, before, 'a second run must be byte-identical');
  assert.match(stdout, /already points here/);
  assert.doesNotMatch(stdout, /repointed/);
});

test("someone else's statusLine is still never clobbered", async () => {
  await setup('--prefix', 'CA');
  const p = join(repo, '.claude', 'settings.json');
  const s = JSON.parse(await readFile(p, 'utf8'));
  s.statusLine = { type: 'command', command: 'my-own-prompt --fancy' };
  await writeFile(p, JSON.stringify(s, null, 2));
  await moveInstall();

  const { stdout } = await setup();
  const after = await json('.claude/settings.json');
  assert.equal(after.statusLine.command, 'my-own-prompt --fancy', 'a foreign statusLine is not ours to repair');
  assert.match(stdout, /not clobbered/);
  // …while the hooks around it are still repaired.
  assert.equal(await stale(), 0);
});

test('setup refuses to run from a package cache, and writes nothing', async () => {
  // Onboarding records where Shipward lives in files the target COMMITS. From a
  // cache npm garbage-collects, that wiring works on day one and breaks
  // silently later, inside files that may already have been pushed to a team.
  const cache = await mkdtemp(join(tmpdir(), 'shipward-npx-'));
  const fake = join(cache, '_npx', 'deadbeef', 'node_modules', 'shipward');
  await mkdir(join(fake, 'shipward'), { recursive: true });
  await mkdir(join(fake, '.claude', 'hooks'), { recursive: true });
  await mkdir(join(fake, '.shipward'), { recursive: true });
  await run('cp', ['-R', join(CENTRAL, 'shipward') + '/.', join(fake, 'shipward')]);
  await run('cp', ['-R', join(CENTRAL, '.claude') + '/.', join(fake, '.claude')]);
  await run('cp', [join(CENTRAL, '.shipward', 'schema.json'), join(fake, '.shipward')]);

  await assert.rejects(
    () => run(process.execPath, [join(fake, 'shipward', 'setup.mjs'), repo]),
    (err) => {
      assert.match(err.stderr, /refusing to onboard/);
      assert.match(err.stderr, /package cache/);
      assert.match(err.stderr, /git clone/, 'it must say what to do instead');
      return true;
    },
  );
  assert.ok(!existsSync(join(repo, '.mcp.json')), 'a refusal must write nothing');
  await rm(cache, { recursive: true, force: true });
});
