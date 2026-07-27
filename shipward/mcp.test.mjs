// MCP server tests. Run: node --test
//
// These drive the real server over a real pipe — spawn, write newline-delimited
// JSON-RPC to stdin, read frames off stdout. Calling the handlers directly
// would not catch a framing bug, and framing is most of what a hand-rolled
// transport can get wrong.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcp.mjs');
const PROTOCOL = '2025-11-25';

let sandbox, tracker;
const sandboxes = [];
const clients = [];

const seed = () => ({
  version: 1,
  activeProject: 'test',
  projects: [{ id: 'test', name: 'Test', tag: 'a test', prefix: 'TS' }],
  cards: [
    mkCard({ id: 'TS-001', title: 'A backlog item', pri: 'P2' }),
    mkCard({ id: 'TS-002', title: 'Urgent thing', pri: 'P1', created: '2026-07-05T00:00:00Z' }),
    mkCard({ id: 'TS-003', title: 'In review already', status: 'review', claude: 'done' }),
  ],
  feed: [{ t: '2026-07-01T00:00:00Z', p: 'test', msg: 'seeded', by: 'user' }],
});

function mkCard(over = {}) {
  return {
    id: 'TS-001', p: 'test', title: 'card', type: 'feature', pri: 'P2', effort: 'M',
    status: 'backlog', claude: null, branch: null, commit: null, note: '',
    created: '2026-07-01T00:00:00Z', pushed: null, shipped: null, ...over,
  };
}

// A minimal MCP client: frames out, frames in, matched by id.
function connect() {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHIPWARD_TRACKER: tracker },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  let buf = '';
  let stderr = '';

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);        // a non-JSON frame must fail loudly
      if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
      else notifications.push(msg);
    }
  });
  proc.stderr.on('data', (d) => { stderr += d; });

  // Captured at spawn: 'exit' fires once, so a listener attached afterwards
  // would wait forever for an event that already happened.
  const exited = new Promise((r) => proc.once('exit', r));

  let nextId = 1;
  const client = {
    proc,
    exited,
    frames: () => notifications,
    stderr: () => stderr,
    send: (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`),
    raw: (line) => proc.stdin.write(`${line}\n`),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${stderr}`)), 10000);
        pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); resolve(msg); });
        client.send({ jsonrpc: '2.0', id, method, params });
      });
    },
    async call(name, args) {
      const res = await client.request('tools/call', { name, arguments: args });
      assert.ok(res.result, `tools/call ${name} errored: ${JSON.stringify(res.error)}`);
      return { text: res.result.content.map((c) => c.text).join('\n'), isError: !!res.result.isError };
    },
    close: () => proc.stdin.end(),
  };
  clients.push(client);
  return client;
}

async function handshake() {
  const c = connect();
  const res = await c.request('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { c, res };
}

const doc = async () => JSON.parse(await readFile(tracker, 'utf8'));

// Board state without the MCP heartbeat. The server stamps doc.mcp while it
// runs, so a raw byte comparison would call every read-only tool a writer.
const board = async () => {
  const { mcp, ...rest } = await doc();
  return JSON.stringify(rest);
};

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'shipward-mcp-'));
  sandboxes.push(sandbox);
  await mkdir(join(sandbox, '.shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

after(async () => {
  for (const c of clients) c.proc.kill();
  await Promise.all(sandboxes.map((s) => rm(s, { recursive: true, force: true }).catch(() => {})));
});

test('initialize returns a protocol version and the tool capability', async () => {
  const { res } = await handshake();
  assert.equal(res.result.protocolVersion, PROTOCOL);
  assert.equal(res.result.serverInfo.name, 'shipward');
  assert.ok(res.result.capabilities.tools, 'must advertise tools');
  assert.match(res.result.instructions, /memory/i, 'the client is told what the tracker is for');
});

test('an older client is answered in its own protocol version', async () => {
  const c = connect();
  const res = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(res.result.protocolVersion, '2024-11-05');

  const unknown = await c.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(unknown.result.protocolVersion, PROTOCOL, 'an unknown version falls back to ours');
});

test('tools/list exposes the five verbs with usable schemas', async () => {
  const { c } = await handshake();
  const { result } = await c.request('tools/list');
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['done', 'log', 'standup', 'start', 'sync']);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} needs an object schema`);
    assert.ok(t.description.length > 40, `${t.name} needs a description the model can act on`);
  }
  const log = result.tools.find((t) => t.name === 'log');
  assert.deepEqual(log.inputSchema.required, ['title']);
});

test('standup reports the board and writes nothing', async () => {
  const { c } = await handshake();
  const before = await board();
  const { text, isError } = await c.call('standup', {});

  assert.equal(isError, false);
  assert.match(text, /Test \(TS\) — 3 cards/);
  assert.match(text, /Waiting on you \(1\)/);
  assert.match(text, /TS-003 — In review already/);
  assert.match(text, /Backlog \(2\)/);
  // P1 leads P2 regardless of the order in the file
  assert.ok(text.indexOf('TS-002') < text.indexOf('TS-001'), 'backlog is sorted by priority');
  assert.equal(await board(), before, 'standup touches no board state');
});

test('standup counts only the last seven days as shipped', async () => {
  const d = seed();
  d.cards.push(mkCard({ id: 'TS-010', title: 'Fresh', status: 'pushed', pushed: new Date(Date.now() - 86400_000).toISOString() }));
  d.cards.push(mkCard({ id: 'TS-011', title: 'Ancient', status: 'shipped', shipped: '2020-01-01T00:00:00Z' }));
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text } = await c.call('standup', {});
  assert.match(text, /Shipped in the last 7 days \(1\)/);
  assert.match(text, /TS-010/);
  assert.doesNotMatch(text, /Ancient/);
});

test('log adds a backlog card with the next id and a feed entry', async () => {
  const { c } = await handshake();
  const { text, isError } = await c.call('log', {
    title: 'Poll loop leaks a timer', type: 'bug', pri: 'P1', effort: 'S', note: 'seen under load',
  });
  assert.equal(isError, false);
  assert.match(text, /TS-004/);

  const d = await doc();
  const card = d.cards.find((x) => x.id === 'TS-004');
  assert.equal(card.status, 'backlog');
  assert.equal(card.type, 'bug');
  assert.equal(card.pri, 'P1');
  assert.equal(card.note, 'seen under load');
  assert.equal(card.claude, null);
  assert.equal(d.feed[0].msg, "You added TS-004 to Backlog — it's on the list");
  assert.equal(d.feed[0].by, 'claude', 'the MCP server is not the human');
});

test('log defaults type, priority and effort rather than refusing', async () => {
  const { c } = await handshake();
  await c.call('log', { title: 'Just a title' });
  const card = (await doc()).cards.find((x) => x.id === 'TS-004');
  assert.deepEqual([card.type, card.pri, card.effort], ['feature', 'P2', 'M']);
});

test('log refuses an empty title without touching the file', async () => {
  const { c } = await handshake();
  const before = await board();
  const { text, isError } = await c.call('log', { title: '   ' });
  assert.equal(isError, true);
  assert.match(text, /needs a title/);
  assert.equal(await board(), before);
});

test('start takes the card, names a branch, and hands back the note', async () => {
  const d = seed();
  d.cards[0].note = 'the context a later session needs';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text, isError } = await c.call('start', { id: 'TS-001' });
  assert.equal(isError, false);
  assert.match(text, /feat\/a-backlog-item/);
  assert.match(text, /the context a later session needs/);
  assert.match(text, /git checkout -b/);

  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.equal(card.status, 'claude');
  assert.equal(card.claude, 'working');
  assert.equal(card.branch, 'feat/a-backlog-item');
  assert.equal((await doc()).feed[0].msg, 'TS-001 handed to Claude Code — queued');
});

test('start twice is idempotent and still reports the context', async () => {
  const { c } = await handshake();
  await c.call('start', { id: 'TS-001', branch: 'feat/mine' });
  const { text, isError } = await c.call('start', { id: 'TS-001' });
  assert.equal(isError, false);
  assert.match(text, /already in progress on feat\/mine/);
  const d = await doc();
  assert.equal(d.cards.find((x) => x.id === 'TS-001').branch, 'feat/mine', 'the branch is not renamed');
  assert.equal(d.feed.filter((f) => f.msg.startsWith('TS-001 handed')).length, 1, 'no duplicate feed entry');
});

test('an unknown id lists the closest backlog cards instead of just failing', async () => {
  const { c } = await handshake();
  const { text, isError } = await c.call('start', { id: 'TS-999' });
  assert.equal(isError, true);
  assert.match(text, /no card TS-999/);
  assert.match(text, /TS-001 — A backlog item/, 'it says what IS startable');
});

test('done moves the card to review with a sha and an appended note', async () => {
  const { c } = await handshake();
  await c.call('start', { id: 'TS-001' });
  const { text } = await c.call('done', { id: 'TS-001', commit: 'abc1234', note: 'used a queue, not a mutex' });
  assert.match(text, /→ review at abc1234/);

  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.equal(card.status, 'review');
  assert.equal(card.claude, 'done');
  assert.equal(card.commit, 'abc1234');
  assert.match(card.note, /used a queue, not a mutex/);
  assert.equal((await doc()).feed[0].msg, 'TS-001 moved to Review — give it a look');
});

test('done keeps the existing note and appends to it', async () => {
  const d = seed();
  d.cards[0].note = 'original context';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const { c } = await handshake();
  await c.call('done', { id: 'TS-001', note: 'and what happened' });
  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.match(card.note, /^original context/, 'the memory this product exists to keep is not overwritten');
  assert.match(card.note, /and what happened/);
});

test('done with pushed stamps the timestamp', async () => {
  const { c } = await handshake();
  await c.call('done', { id: 'TS-001', pushed: true, commit: 'deadbee' });
  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.equal(card.status, 'pushed');
  assert.ok(Date.parse(card.pushed) > 0, 'pushed must carry a real timestamp');
});

test('sync applies updates and creations in one write with one feed entry', async () => {
  const { c } = await handshake();
  const { text, isError } = await c.call('sync', {
    summary: 'two branches were merged last week',
    updates: [
      { id: 'TS-003', status: 'pushed', commit: 'aaa1111' },
      { id: 'TS-001', note: 'branch exists but no commits' },
    ],
    create: [{ title: 'Untracked refactor found in git', type: 'chore', status: 'pushed', commit: 'bbb2222' }],
  });
  assert.equal(isError, false);
  assert.match(text, /2 updated, 1 created/);

  const d = await doc();
  assert.equal(d.cards.find((x) => x.id === 'TS-003').status, 'pushed');
  assert.equal(d.cards.find((x) => x.id === 'TS-003').commit, 'aaa1111');
  assert.match(d.cards.find((x) => x.id === 'TS-001').note, /no commits/);
  const made = d.cards.find((x) => x.title === 'Untracked refactor found in git');
  assert.equal(made.id, 'TS-004');
  assert.equal(made.status, 'pushed');
  assert.ok(Date.parse(made.pushed) > 0);
  assert.equal(d.feed[0].msg, 'Synced with git — two branches were merged last week');
  assert.equal(d.feed.filter((f) => f.msg.startsWith('Synced')).length, 1, 'one entry for the whole audit');
});

test('a sync naming an unknown card writes nothing at all', async () => {
  const { c } = await handshake();
  const before = await board();
  const { isError, text } = await c.call('sync', {
    summary: 'partly wrong',
    updates: [{ id: 'TS-001', commit: 'aaa1111' }, { id: 'TS-404', status: 'pushed' }],
  });
  assert.equal(isError, true);
  assert.match(text, /no card TS-404/);
  assert.equal(await board(), before, 'the whole batch is atomic');
});

test('two messages arriving in one chunk are both answered', async () => {
  // The transport must not assume one write is one message.
  const { c } = await handshake();
  const a = c.request('tools/list');
  const b = c.request('ping');
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra.result.tools);
  assert.deepEqual(rb.result, {});
});

test('a split message is buffered until its newline arrives', async () => {
  const { c } = await handshake();
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list' });
  const done = new Promise((resolve) => {
    const check = setInterval(() => {
      const hit = c.frames().find((f) => f.id === 900);
      if (hit) { clearInterval(check); resolve(hit); }
    }, 20);
  });
  c.proc.stdin.write(frame.slice(0, 12));
  await new Promise((r) => setTimeout(r, 60));
  c.proc.stdin.write(`${frame.slice(12)}\n`);
  const hit = await done;
  assert.ok(hit.result.tools, 'the halves were joined, not parsed separately');
});

test('a notification is never answered', async () => {
  const { c } = await handshake();
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  c.send({ jsonrpc: '2.0', method: 'notifications/something-we-do-not-know' });
  await c.request('ping');                        // a later request still works
  assert.equal(c.frames().length, 0, 'notifications produced no frames');
});

test('malformed input is refused without killing the server', async () => {
  const { c } = await handshake();
  c.raw('this is not json');
  c.raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  const alive = await c.request('tools/list');
  assert.ok(alive.result.tools, 'the server survived both');

  const codes = c.frames().filter((f) => f.error).map((f) => f.error.code);
  assert.ok(codes.includes(-32700), 'parse error reported');
  assert.ok(codes.includes(-32600), 'batches refused explicitly');
});

test('an unknown method gets -32601, an unknown tool gets a readable result', async () => {
  const { c } = await handshake();
  const bad = await c.request('resources/list');
  assert.equal(bad.error.code, -32601);

  const { text, isError } = await c.call('teleport', {});
  assert.equal(isError, true, 'a wrong tool name is the model\'s to fix, not a protocol failure');
  assert.match(text, /Available: standup, log, start, done, sync/);
});

test('nothing but protocol frames reaches stdout', async () => {
  // One stray console.log would corrupt the stream for every client.
  const { c } = await handshake();
  await c.call('standup', {});
  await c.call('log', { title: 'noise check' });
  assert.equal(c.frames().length, 0, 'no unsolicited frames');
  assert.match(c.stderr(), /ready — 5 tools/, 'the banner went to stderr');
});

test('a tool call against a missing tracker says so instead of crashing', async () => {
  await rm(tracker);
  const { c } = await handshake();
  const { text, isError } = await c.call('standup', {});
  assert.equal(isError, true);
  assert.match(text, /not found|has not been set up/i);
});

test('closing stdin drains the queue instead of killing the write', async () => {
  // REGRESSION, found by smoke-testing the real binary: stdin 'end' called
  // process.exit immediately, so a tool call still running was killed — no
  // reply, and a write that had taken the tracker lock was simply lost. The
  // other tests all hold stdin open, so none of them saw it.
  const c = connect();
  await c.request('initialize', { protocolVersion: PROTOCOL, capabilities: {} });
  const pending = c.request('tools/call', { name: 'log', arguments: { title: 'written as the pipe closes' } });
  c.close();                                        // end stdin with the call in flight

  const res = await pending;
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  assert.ok((await doc()).cards.some((x) => x.title === 'written as the pipe closes'), 'the write survived');
  assert.equal(await c.exited, 0, 'and then it exits cleanly');
});

test('the server heartbeats so the desk tag can tell the truth', async () => {
  const { c } = await handshake();
  await c.call('standup', {});                      // any call is after the startup beat
  const { mcp } = await doc();
  assert.ok(mcp, 'doc.mcp is stamped on startup, not a minute later');
  assert.ok(Date.now() - Date.parse(mcp.lastSeen) < 10_000, 'and it is recent');
  assert.equal(typeof mcp.pid, 'number');
});

test('a heartbeat never disturbs the board', async () => {
  const { c } = await handshake();
  const before = await board();
  await c.call('standup', {});
  assert.equal(await board(), before, 'cards and feed are untouched by the heartbeat');
});
