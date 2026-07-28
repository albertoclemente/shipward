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
function connect(extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHIPWARD_TRACKER: tracker, ...extraEnv },
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

// The whole note as one string, whichever form it is in — assertions read
// content; the entry structure gets its own dedicated tests.
const noteStr = (note) => (Array.isArray(note) ? note.map((e) => e.text).join('\n') : (note || ''));

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

test('tools/list exposes every verb with a usable schema', async () => {
  const { c } = await handshake();
  const { result } = await c.request('tools/list');
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['done', 'log', 'recall', 'standup', 'start', 'sync']);
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
  assert.deepEqual(card.note.map((e) => ({ kind: e.kind, text: e.text })),
    [{ kind: 'brief', text: 'seen under load' }], 'the opening entry IS the brief, stated not guessed');
  assert.ok(Date.parse(card.note[0].t) > 0, 'entries are dated');
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
  assert.match(noteStr(card.note), /used a queue, not a mutex/);
  assert.ok(Array.isArray(card.note), 'the appended note is a structured entry');
  assert.equal((await doc()).feed[0].msg, 'TS-001 moved to Review — give it a look');
});

test('done keeps the existing note and appends to it', async () => {
  const d = seed();
  d.cards[0].note = 'original context';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const { c } = await handshake();
  await c.call('done', { id: 'TS-001', note: 'and what happened' });
  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.ok(Array.isArray(card.note), 'a prose note converts on first structured append');
  assert.equal(card.note[0].text, 'original context', 'the memory this product exists to keep is not overwritten');
  assert.equal(card.note[0].t, d.cards[0].created, 'converted segments carry the card\'s own clock');
  assert.equal(card.note[1].text, 'and what happened');
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
  assert.match(noteStr(d.cards.find((x) => x.id === 'TS-001').note), /no commits/);
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
  c.raw('[]');
  const alive = await c.request('tools/list');
  assert.ok(alive.result.tools, 'the server survived both');

  const codes = c.frames().filter((f) => f.error).map((f) => f.error.code);
  assert.ok(codes.includes(-32700), 'parse error reported');
  assert.ok(codes.includes(-32600), 'an empty batch is not a request');
});

test('an unknown method gets -32601, an unknown tool gets a readable result', async () => {
  const { c } = await handshake();
  const bad = await c.request('resources/list');
  assert.equal(bad.error.code, -32601);

  const { text, isError } = await c.call('teleport', {});
  assert.equal(isError, true, 'a wrong tool name is the model\'s to fix, not a protocol failure');
  assert.match(text, /Available: standup, recall, log, start, done, sync/);
});

test('nothing but protocol frames reaches stdout', async () => {
  // One stray console.log would corrupt the stream for every client.
  const { c } = await handshake();
  await c.call('standup', {});
  await c.call('log', { title: 'noise check' });
  assert.equal(c.frames().length, 0, 'no unsolicited frames');
  assert.match(c.stderr(), /ready — 6 tools/, 'the banner went to stderr');
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

test('standup carries the memory it used to return none of', async () => {
  const d = seed();
  d.cards[0].note = 'NEEDS ALBERTO: which store should this use?';
  d.cards[1].note = 'DECIDED: zero dependencies, Node built-ins only, forever.';
  d.cards[2].note = ['VERIFIED: 45 tests pass.', 'SHIPPED: it went out.'].join(' || ');
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text } = await c.call('standup', {});

  assert.match(text, /Still open, from the card notes \(1\)/);
  assert.match(text, /which store should this use/);
  assert.match(text, /Decisions not to reverse \(1\)/);
  assert.match(text, /zero dependencies/);
  assert.match(text, /\[TS-001 · \w{3} \d+ \d{4}\]/, 'every entry carries its card, date AND year');
  assert.match(text, /Memory: 4 entries/);
  assert.match(text, /recall\(\{file:/, 'and points at how to get the rest');
});

test('standup stays quiet when there is no memory yet', async () => {
  const { c } = await handshake();
  const { text } = await c.call('standup', {});
  assert.doesNotMatch(text, /Memory:/, 'an empty tracker gets no memory section at all');
});

test('recall reaches a note through the functions it names, not just the filename', async () => {
  // The case this tool exists for. The note names no file — only a function
  // that shipward/tracker-store.mjs actually declares, which is how the real
  // SW-010 note is written.
  const d = seed();
  d.cards[0].note = 'ROOT CAUSE: sweepTmp() deleted a live process\'s in-flight temp file.';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text, isError } = await c.call('recall', { file: 'tracker-store' });
  assert.equal(isError, false);
  assert.match(text, /sweepTmp/);
  assert.match(text, /tracker-store\.mjs, plus the \d+ names it declares/,
    'it says how it bridged from the file to the prose');
});

test('recall reports an empty result without implying nothing happened', async () => {
  const { c } = await handshake();
  const { text, isError } = await c.call('recall', { file: 'nothing-like-this.mjs' });
  assert.equal(isError, false, 'no results is an answer, not a failure');
  assert.match(text, /Nothing recalled/);
  assert.match(text, /not found on disk/);
  assert.match(text, /entries searched/, 'says which haystack was looked through');
});

test('recall labels evidence as perishable', async () => {
  const d = seed();
  d.cards[0].note = 'VERIFIED: 45 tests pass and the stress run was clean.';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text } = await c.call('recall', { kind: 'evidence' });
  assert.match(text, /as of then, not a claim about now/,
    'a measurement is a claim about a past state; 45 was true once and is not now');
});

test('recall refuses to guess, and names the kinds it knows', async () => {
  const { c } = await handshake();
  const blind = await c.call('recall', {});
  assert.equal(blind.isError, true);
  assert.match(blind.text, /needs something to go on/);

  const wrong = await c.call('recall', { kind: 'vibes' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /open, finding, decision, evidence, outcome, brief/);
});

test('recall says what it dropped rather than truncating silently', async () => {
  const d = seed();
  d.cards.forEach((c2, i) => { c2.note = `REPRODUCED: failure number ${i}`; });
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text } = await c.call('recall', { kind: 'finding', limit: 1 });
  assert.match(text, /3 recalled .*, showing 1/);
  assert.match(text, /…2 more not shown/);
});

test('recall writes nothing', async () => {
  const d = seed();
  d.cards[0].note = 'DECIDED: something';
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const { c } = await handshake();
  const before = await board();
  await c.call('recall', { query: 'something' });
  assert.equal(await board(), before);
});


/* -- after the adversarial review (SW-020) ------------------ */

test('a non-string note is refused rather than bricking the memory surface', async () => {
  // It used to be written verbatim: standup and recall then threw, the
  // SessionStart hook emitted zero bytes so the session silently got no
  // standup, and cards cannot be deleted by protocol, so recovery meant a
  // hand-edit.
  const { c } = await handshake();
  for (const note of [42, { deep: 'object' }, ['a']]) {
    const r = await c.call('log', { title: 'poison attempt', note });
    assert.equal(r.isError, true, `note ${JSON.stringify(note)} was accepted`);
    assert.match(r.text, /note must be a string/);
  }
  const bad = await c.call('done', { id: 'TS-002', note: { deep: 'object' } });
  assert.equal(bad.isError, true);

  const after = await c.call('standup', {});
  assert.equal(after.isError, false, 'the memory surface still works');
});

test('the handshake does not wait behind a tracker write', async () => {
  // The startup heartbeat was queued AHEAD of initialize, so the handshake
  // could not answer until a write completed — 62s when a lock was never
  // released. A handshake bounded by the lock timeout is a dead server.
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(`${tracker}.lock`, JSON.stringify({ pid: process.pid, token: 'held-by-the-test', at: Date.now() }));
  try {
    const c = connect();
    const started = Date.now();
    const res = await c.request('initialize', { protocolVersion: PROTOCOL, capabilities: {} });
    const took = Date.now() - started;
    assert.equal(res.result.protocolVersion, PROTOCOL);
    assert.ok(took < 5000, `initialize took ${took}ms with the tracker lock held`);

    const listed = await c.request('tools/list');
    assert.ok(listed.result.tools, 'and read-only protocol frames answer too');
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(`${tracker}.lock`).catch(() => {});
  }
});

test('a reply larger than the pipe buffer is not truncated when stdin closes', async () => {
  // process.exit() discarded whatever had not flushed: the last frame stopped
  // at exactly 65525 bytes, unparseable, with exit code 0 so nothing signalled
  // failure.
  const d = seed();
  d.cards = d.cards.map((x, i) => ({ ...x, note: `REPRODUCED: ${'padding '.repeat(4000)} ${i}` }));
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const c = connect();
  await c.request('initialize', { protocolVersion: PROTOCOL, capabilities: {} });
  const pending = c.request('tools/call', { name: 'recall', arguments: { kind: 'finding', limit: 50 } });
  c.close();                                   // stdin ends with a big reply in flight

  const res = await pending;
  assert.ok(res.result, 'the reply arrived whole');
  assert.ok(res.result.content[0].text.length > 70000, `reply was ${res.result.content[0].text.length} chars`);
  assert.equal(await c.exited, 0);
});

test('a request without an id is ignored, and never writes', async () => {
  // These produced a response with no id member, and a success response with
  // id:null — both invalid — and a tools/call notification still mutated the
  // tracker while telling the caller nothing it could match.
  const { c } = await handshake();
  const before = await board();
  c.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'log', arguments: { title: 'silent write' } } });
  c.send({ jsonrpc: '2.0', id: null, method: 'tools/list' });

  await c.request('ping');                      // ordering barrier
  assert.equal(c.frames().length, 0, 'no invalid frames were emitted');
  assert.equal(await board(), before, 'and nothing was written');
});

test('a batch is answered as a batch, since we advertise revisions that allow one', async () => {
  const { c } = await handshake();
  const replies = await new Promise((resolve) => {
    const check = setInterval(() => {
      const hit = c.frames().find((f) => Array.isArray(f));
      if (hit) { clearInterval(check); resolve(hit); }
    }, 20);
    c.proc.stdin.write(JSON.stringify([
      { jsonrpc: '2.0', id: 501, method: 'ping' },
      { jsonrpc: '2.0', id: 502, method: 'tools/list' },
    ]) + '\n');
  });
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((r) => r.id).sort(), [501, 502]);
});

test('sync refuses a nameless card the way log does', async () => {
  const { c } = await handshake();
  const before = await board();
  const r = await c.call('sync', { summary: 'audit', create: [{ title: '   ' }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a title/);
  assert.equal(await board(), before, 'and the whole batch is still atomic');
});

test('done on an already-pushed card does not claim a stamp it never wrote', async () => {
  const { c } = await handshake();
  await c.call('done', { id: 'TS-001', pushed: true });
  const first = (await doc()).cards.find((x) => x.id === 'TS-001').pushed;
  assert.ok(Date.parse(first) > 0);

  const again = await c.call('done', { id: 'TS-001', pushed: true, commit: 'abc1234' });
  assert.equal(again.isError, false);
  const card = (await doc()).cards.find((x) => x.id === 'TS-001');
  assert.ok(Date.parse(card.pushed) > 0, 'the stamp the reply promises must actually be there');
  assert.equal(card.pushed, first, 'and the original timestamp is not moved');
});

test('the thousandth card of a prefix fails with something actionable', async () => {
  const d = seed();
  d.cards.push(mkCard({ id: 'TS-999', title: 'the last one' }));
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const r = await c.call('log', { title: 'one too many' });
  assert.equal(r.isError, true);
  assert.match(r.text, /full at 999 cards/, 'the schema error it used to give said nothing about what to do');
});

test('a nonsense limit does not print a total and then list nothing', async () => {
  const d = seed();
  d.cards = d.cards.map((x, i) => ({ ...x, note: `REPRODUCED: finding ${i}` }));
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const { c } = await handshake();
  const { text } = await c.call('recall', { kind: 'finding', limit: 'all' });
  assert.match(text, /3 recalled/);
  assert.match(text, /finding 0/, 'the entries themselves must be there');
});


/* -- cancellation (SW-021) ---------------------------------- */

test('a cancelled call that never started does not run and gets no reply', async () => {
  // It used to be accepted and ignored: the call ran, wrote, and held the queue.
  const { c } = await handshake();
  const before = await board();

  // Hold the tracker lock so the call cannot begin.
  const { writeFile: wf, unlink } = await import('node:fs/promises');
  await wf(`${tracker}.lock`, JSON.stringify({ pid: process.pid, token: 'held-by-the-test', at: Date.now() }));
  try {
    c.send({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name: 'log', arguments: { title: 'should never exist' } } });
    await new Promise((r) => setTimeout(r, 300));
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 700 } });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await unlink(`${tracker}.lock`).catch(() => {});
  }

  // A tools/call queues BEHIND the cancelled one, so once this answers the
  // cancelled call has definitively resolved. tools/list would not: protocol
  // frames deliberately no longer wait on the write queue, and using one here
  // let the assertion race the write it was meant to catch.
  const after = await c.call('standup', {});
  assert.equal(after.isError, false, 'the server is still healthy');
  assert.equal(c.frames().find((f) => f.id === 700), undefined, 'a cancelled request gets no response');
  assert.equal(await board(), before, 'and nothing was written');
});

test('cancelling frees the queue for the calls behind it', async () => {
  const { c } = await handshake();
  const { writeFile: wf, unlink } = await import('node:fs/promises');
  await wf(`${tracker}.lock`, JSON.stringify({ pid: process.pid, token: 'held-by-the-test', at: Date.now() }));

  c.send({ jsonrpc: '2.0', id: 710, method: 'tools/call', params: { name: 'log', arguments: { title: 'blocked' } } });
  await new Promise((r) => setTimeout(r, 200));
  const queued = c.request('tools/call', { name: 'standup', arguments: {} });
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 710 } });
  await unlink(`${tracker}.lock`).catch(() => {});

  const res = await queued;
  assert.ok(res.result, 'the call behind it completed');
  assert.equal(c.frames().find((f) => f.id === 710), undefined);
  assert.ok(!(await doc()).cards.some((x) => x.title === 'blocked'), 'the cancelled write never landed');
});

test('cancelling an unknown or already-finished id is harmless', async () => {
  const { c } = await handshake();
  const done = await c.call('standup', {});
  assert.equal(done.isError, false);

  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99999 } });
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
  c.send({ jsonrpc: '2.0', method: 'notifications/cancelled' });

  const alive = await c.request('ping');
  assert.deepEqual(alive.result, {}, 'the reply and the cancellation crossing is the normal race');
});

test('an uncancelled call still answers normally', async () => {
  const { c } = await handshake();
  const r = await c.call('log', { title: 'not cancelled' });
  assert.equal(r.isError, false);
  assert.ok((await doc()).cards.some((x) => x.title === 'not cancelled'));
});

/* ── sync against a real repository (SW-024) ─────────────── */

// Stages one card per tier against a throwaway repo. A mock of git would only
// prove I can predict git, which is the thing in doubt.
async function repoWithAllThreeTiers() {
  const { execFile } = await import('node:child_process');
  const sh = (await import('node:util')).promisify(execFile);
  const repo = await mkdtemp(join(tmpdir(), 'shipward-mcpgit-'));
  const g = (...a) => sh('git', a, { cwd: repo });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@e.com');
  await g('config', 'user.name', 'T');
  await writeFile(join(repo, 'a'), '1'); await g('add', '-A'); await g('commit', '-qm', 'first');

  await g('checkout', '-qb', 'feat/landed');
  await writeFile(join(repo, 'b'), '2'); await g('add', '-A'); await g('commit', '-qm', 'landed');
  const landed = (await g('rev-parse', '--short', 'HEAD')).stdout.trim();
  await g('checkout', '-q', 'main');
  await g('merge', '-q', '--no-ff', '-m', 'merge', 'feat/landed');

  await g('checkout', '-qb', 'feat/started');
  await writeFile(join(repo, 'c'), '3'); await g('add', '-A'); await g('commit', '-qm', 'work');
  const unlanded = (await g('rev-parse', '--short', 'HEAD')).stdout.trim();
  await g('checkout', '-q', 'main');
  return { repo, landed, unlanded };
}

const tierBoard = (landed, unlanded) => ({
  version: 1,
  activeProject: 'test',
  projects: [{ id: 'test', name: 'Test', tag: 'a test', prefix: 'TS' }],
  cards: [
    mkCard({ id: 'TS-001', title: 'Landed, board says review', status: 'review', branch: 'feat/landed', commit: landed }),
    mkCard({ id: 'TS-002', title: 'Work exists, board says backlog', status: 'backlog', branch: 'feat/started' }),
    mkCard({ id: 'TS-003', title: 'Claims pushed, never landed', status: 'pushed', commit: unlanded }),
  ],
  feed: [],
});

// handshake(), but against a staged repository.
async function handshakeIn(repo) {
  const c = connect({ SHIPWARD_REPO: repo });
  await c.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return c;
}

test('the dry run names which tier each finding is in', async () => {
  const { repo, landed, unlanded } = await repoWithAllThreeTiers();
  try {
    await writeFile(tracker, JSON.stringify(tierBoard(landed, unlanded), null, 2) + '\n');
    const c = await handshakeIn(repo);
    const { text } = await c.call('sync', { summary: 'audit', fromGit: true });

    assert.match(text, /4 discrepancies/);
    assert.match(text, /2 git can settle on its own, 1 it can propose, 1 needing a human/);
    assert.match(text, /status=pushed; git settles this itself at session start/);
    assert.match(text, /would set status=claude on apply:true/);
    assert.match(text, /needs a human; git can only raise the question/);

    // A dry run is a dry run.
    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    assert.equal(onDisk.cards.find((x) => x.id === 'TS-001').status, 'review');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('apply:true accepts the inferences and still refuses to demote a card', async () => {
  const { repo, landed, unlanded } = await repoWithAllThreeTiers();
  try {
    await writeFile(tracker, JSON.stringify(tierBoard(landed, unlanded), null, 2) + '\n');
    const c = await handshakeIn(repo);
    await c.call('sync', { summary: 'accepted', fromGit: true, apply: true });

    const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
    const by = (id) => onDisk.cards.find((x) => x.id === id);
    assert.equal(by('TS-001').status, 'pushed', 'certain: the commit is on main');
    assert.equal(by('TS-002').status, 'claude', 'proposed: accepted because it was asked for');
    assert.ok(by('TS-002').commit, 'and the certain half of the same card landed too');

    // The monotonicity guarantee. TS-003's commit is on no branch anywhere, but
    // an audit that could retract a human's claim is an audit nobody would let
    // run unattended.
    assert.equal(by('TS-003').status, 'pushed', 'reported: never written, even on an explicit apply');
    assert.equal(by('TS-003').note, '', 'and not annotated either — nothing happened to it');

    // One card, two rules, two reasons, one note.
    const audits = by('TS-002').note.filter((e) => e.text.includes('[git audit'));
    assert.equal(audits.length, 1, 'one card, one audit, ONE entry — even when two rules fired');
    assert.equal(audits[0].text.match(/\[git audit/g).length, 2, 'both reasons in it');
    assert.equal(audits[0].kind, 'evidence', 'audit entries state their kind — the classifier never guesses them');
    assert.equal(onDisk.feed.length, 1, 'one entry for the audit, not one per card');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
