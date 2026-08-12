// The CLI surface. Run: node --test
//
// SW-048. Driven as a real process against a throwaway board, because the
// contract is argv in, text and an exit code out — and an exit code is
// something only a spawned process actually has.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './mcp.mjs';
import { parse, usage } from './cli.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.mjs');

let sandbox, tracker;

const seed = () => ({
  version: 1,
  activeProject: 'demo',
  projects: [{ id: 'demo', name: 'Demo', tag: 'a demo', prefix: 'DM' }],
  cards: [],
  feed: [],
});

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'shipward-cli-'));
  await mkdir(join(sandbox, '.shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

after(async () => { await rm(sandbox, { recursive: true, force: true }); });

// Never the real board: explicit env, the belt SW-033 taught at full price.
const cli = async (...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, SHIPWARD_TRACKER: tracker, SHIPWARD_REPO: sandbox },
    });
    return { out: stdout.trim(), err: stderr.trim(), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || '').trim(), err: String(e.stderr || '').trim(), code: e.code };
  }
};

const board = async () => JSON.parse(await readFile(tracker, 'utf8'));

/* ── the same six, no more and no fewer ──────────────────── */

test('every MCP tool is reachable as a subcommand, and nothing else is', () => {
  // Drift by construction is the thing this card exists to avoid: the CLI
  // dispatches over the TOOLS table itself, so a tool the server gains is a
  // subcommand the CLI gains.
  const named = TOOLS.map((t) => t.name);
  assert.deepEqual(named, ['standup', 'recall', 'log', 'start', 'done', 'sync']);
  for (const n of named) assert.match(usage(), new RegExp(`\\b${n}\\b`));
});

test('help lists the commands and names the board it would write', () => {
  assert.match(usage(), /shipward — the tracker, from a shell/);
  assert.match(usage(), /Board: /);
});

/* ── argv, parsed against each tool's own schema ─────────── */

const toolNamed = (n) => TOOLS.find((t) => t.name === n);

test('a positional fills the argument that command is about', () => {
  assert.deepEqual(parse(toolNamed('start'), ['SW-042']), { id: 'SW-042' });
  assert.deepEqual(parse(toolNamed('log'), ['a title with spaces']), { title: 'a title with spaces' });
});

test('flags take values either way round', () => {
  assert.deepEqual(parse(toolNamed('log'), ['t', '--type', 'bug']), { title: 't', type: 'bug' });
  assert.deepEqual(parse(toolNamed('log'), ['t', '--type=bug']), { title: 't', type: 'bug' });
});

test('a number flag arrives as a number, not a string', () => {
  // recall({limit}) is compared with Number.isInteger; "10" would fail that
  // silently and fall back to the default.
  assert.deepEqual(parse(toolNamed('recall'), ['--limit', '25']), { limit: 25 });
});

test('a boolean flag is true by its presence', () => {
  assert.deepEqual(parse(toolNamed('sync'), ['--from-git']), { fromGit: true });
  assert.deepEqual(parse(toolNamed('sync'), ['--from-git=false']), { fromGit: false });
});

test('an explicit flag beats the positional rather than fighting it', () => {
  assert.deepEqual(parse(toolNamed('start'), ['SW-001', '--id', 'SW-002']), { id: 'SW-002' });
});

test('an unknown flag says what the command does take', () => {
  assert.throws(() => parse(toolNamed('log'), ['t', '--priority', 'P1']), /has no --priority.*--pri/s);
});

test('a positional where none is allowed is refused rather than ignored', () => {
  assert.throws(() => parse(toolNamed('standup'), ['SW-001']), /takes no positional/);
});

/* ── as a process ────────────────────────────────────────── */

test('standup reads the board and exits zero', async () => {
  const { out, code } = await cli('standup');
  assert.equal(code, 0);
  assert.match(out, /^Demo \(DM\) — 0 cards/);
});

test('log writes a card, and start takes it', async () => {
  const logged = await cli('log', 'the desk overflows below 444px', '--type', 'bug', '--pri', 'P1');
  assert.equal(logged.code, 0);
  assert.match(logged.out, /DM-001 added/);

  const started = await cli('start', 'DM-001');
  assert.equal(started.code, 0);
  assert.match(started.out, /DM-001 is yours/);

  const card = (await board()).cards.find((c) => c.id === 'DM-001');
  assert.equal(card.type, 'bug');
  assert.equal(card.pri, 'P1');
  assert.equal(card.status, 'claude');
  assert.equal(card.branch, 'fix/the-desk-overflows', 'branch naming is the shared rule, not a second copy');
});

test('done hands the card back, through the same gate the MCP server uses', async () => {
  const { out, code } = await cli('done', 'DM-001', '--commit', 'abc1234',
    '--note', 'swapped the parser because the old one buffered the whole file', '--kind', 'outcome');
  assert.equal(code, 0);
  assert.match(out, /DM-001 → review at abc1234/);
  // This project declares no checks, and the reply says so rather than
  // implying the work was verified (SW-043).
  assert.match(out, /Unverified/);

  const card = (await board()).cards.find((c) => c.id === 'DM-001');
  assert.equal(card.status, 'review');
  // The note is NOT in tracker.json: SW-039 moved entries to an append-only
  // .shipward/notes.jsonl sidecar that the store hydrates on read. Asserting
  // against the raw file would test the storage layout; asking the CLI to
  // recall what the CLI just wrote tests the thing that matters.
  const recalled = await cli('recall', '--kind', 'outcome');
  assert.equal(recalled.code, 0);
  assert.match(recalled.out, /swapped the parser/);
  assert.match(recalled.out, /DM-001/);
});

test('a caller mistake exits 1 with a readable message and no stack', async () => {
  const { err, out, code } = await cli('start', 'DM-999');
  assert.equal(code, 1);
  const text = err || out;
  assert.match(text, /no card DM-999/);
  assert.doesNotMatch(text, /at Object|\.mjs:\d+/, 'a ToolError is the caller\'s mistake, not a crash to debug');
});

test('an unknown command lists the real ones', async () => {
  const { err, out, code } = await cli('frobnicate');
  assert.equal(code, 1);
  assert.match(err || out, /no command "frobnicate".*standup, recall, log, start, done, sync/s);
});

test('no arguments prints usage and exits nonzero, so a script notices', async () => {
  const { code } = await cli();
  assert.equal(code, 1);
  const asked = await cli('help');
  assert.equal(asked.code, 0, 'asking for help is not an error');
});

test('errors go to stderr and results to stdout, so `shipward standup > file` is clean', async () => {
  const ok = await cli('standup');
  assert.ok(ok.out.length);
  const bad = await cli('start', 'DM-999');
  assert.ok(bad.err.length, 'the message belongs on stderr');
  assert.equal(bad.out, '', 'and nothing on stdout for a script to swallow');
});

/* ── the token claim this card exists to keep honest ─────── */

test('the whole MCP tool surface stays close to a CLI in token cost', async () => {
  // The standing argument against MCP for Claude Code is token cost — schemas
  // said to run 10-50k against ~1-2k for a CLI. Measured 2026-07-31, this
  // server's tools/list is 6,843 bytes for all six tools: ~1.7k tokens, i.e.
  // parity with a CLI. That is a claim worth making out loud and therefore a
  // claim worth a test, so it cannot quietly stop being true.
  const payload = JSON.stringify({ tools: TOOLS.map(({ run: _run, ...t }) => t) });
  assert.ok(payload.length < 12000,
    `the tool surface is ${payload.length} bytes (~${Math.round(payload.length / 4)} tokens) — past 12k it stops being at parity with a CLI`);
});
