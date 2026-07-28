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
