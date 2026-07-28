// Server tests: the I/O matrix rows that live in serve.mjs. Run: node --test
// Boots the real server against a throwaway tracker file in a temp dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let sandbox, tracker, proc, base;

const seed = () => ({
  version: 1,
  activeProject: 'test',
  projects: [{ id: 'test', name: 'Test', tag: 't', prefix: 'TS' }],
  cards: [{
    id: 'TS-001', p: 'test', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
    status: 'backlog', claude: null, branch: null, commit: null,
    created: '2026-07-01T00:00:00Z', pushed: null, shipped: null,
  }],
  feed: [{ t: '2026-07-01T00:00:00Z', p: 'test', msg: 'seeded', by: 'user' }],
});

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'shipward-test-'));
  await mkdir(join(sandbox, '.shipward'));
  await mkdir(join(sandbox, 'shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
  await cp(join(HERE, 'tracker-store.mjs'), join(sandbox, 'shipward', 'tracker-store.mjs'));
  await cp(join(HERE, 'public'), join(sandbox, 'shipward', 'public'), { recursive: true });
  await cp(join(HERE, 'serve.mjs'), join(sandbox, 'shipward', 'serve.mjs'));

  // SHIPWARD_PORT=0 lets the OS pick. A fixed port meant a leftover server from
  // an earlier run kept the port, this spawn died on EADDRINUSE, and the suite
  // then asserted against the STALE server instead of failing.
  // cwd matters since SW-033: the store prefers the tracker of the directory
  // you stand in over the install's own. This sandbox IS the repo under test,
  // so stand in it — spawning from the real repo would serve the real board.
  proc = spawn(process.execPath, [join(sandbox, 'shipward', 'serve.mjs')], {
    cwd: sandbox,
    env: { ...process.env, SHIPWARD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server never reported a port. stderr: ${stderr}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/api/tracker`);   // the port is bound before it is printed
});

after(() => proc?.kill());

const etag = async () => (await fetch(`${base}/api/tracker`)).headers.get('etag');

const put = async (body, ifMatch) => fetch(`${base}/api/tracker`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'if-match': ifMatch ?? (await etag()) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('GET returns the tracker', async () => {
  const res = await fetch(`${base}/api/tracker`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cards[0].id, 'TS-001');
});

test('a malformed request path does not kill the server', async () => {
  // GET /% used to throw URIError out of an async handler and exit the process
  assert.equal((await fetch(`${base}/%`)).status, 400);
  assert.equal((await fetch(`${base}/%zz`)).status, 400);
  assert.equal((await fetch(`${base}/api/tracker`)).status, 200, 'server still alive');
});

test('path traversal is refused', async () => {
  for (const p of ['/../serve.mjs', '/%2e%2e/serve.mjs', '/../../.shipward/tracker.json']) {
    assert.ok([403, 404].includes((await fetch(base + p)).status), `${p} must not be served`);
  }
});

test('rejected writes leave the file byte-identical', async () => {
  const before = await readFile(tracker, 'utf8');
  const cases = [
    ['not json', 400],
    [{ hello: 1 }, 400],
    [{ version: 2, projects: [], cards: [], feed: [] }, 400],
    [{ version: 1, projects: [], cards: [{}], feed: [] }, 400],               // card with no id
    [{ version: 1, projects: [], cards: [], feed: [0] }, 400],                // feed entry is a number
    [{ ...seed(), cards: [{ ...seed().cards[0], id: 'bad-id' }] }, 400],      // id fails the schema pattern
    [{ ...seed(), cards: [{ ...seed().cards[0], status: 'nope' }] }, 400],
    [{ ...seed(), cards: [seed().cards[0], seed().cards[0]] }, 400],          // duplicate ids
  ];
  for (const [body, expected] of cases) {
    assert.equal((await put(body)).status, expected, `body ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.equal(await readFile(tracker, 'utf8'), before, 'file untouched by rejected writes');
});

test('a valid write persists and round-trips', async () => {
  const doc = seed();
  doc.cards[0].status = 'review';
  assert.equal((await put(doc)).status, 200);
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards[0].status, 'review');
  await put(seed());   // restore
});

test('concurrent writes from one base: exactly one wins, the rest 409', async () => {
  // Originally this asserted all six succeeded — that was the bug. Overlapping
  // PUTs also shared one temp path and left unparseable JSON. Now the file
  // stays valid AND a writer working from an overtaken base is refused rather
  // than silently overwriting the winner.
  for (let round = 0; round < 15; round++) {
    const from = await etag();
    const docs = Array.from({ length: 6 }, (_, i) => {
      const d = seed();
      d.cards[0].title = `concurrent ${round}-${i}`.padEnd(500, 'x');
      return d;
    });
    const codes = await Promise.all(docs.map((d) => put(d, from).then((r) => r.status)));
    assert.equal(codes.filter((c) => c === 200).length, 1, `round ${round}: one winner, got ${codes}`);
    assert.ok(codes.every((c) => c === 200 || c === 409), `round ${round}: ${codes}`);

    const raw = await readFile(tracker, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `round ${round} left unparseable JSON`);
    assert.equal(JSON.parse(raw).cards[0].title.startsWith(`concurrent ${round}-`), true,
      'the file holds one writer\'s whole document, not a blend');
  }
  const leftovers = (await readdir(join(sandbox, '.shipward')))
    .filter((f) => f.endsWith('.tmp') || f.includes('.lock'));
  assert.deepEqual(leftovers, [], 'no orphan temp or lock files');
  await put(seed());
});

test('GET refuses to serve a tracker that is not a tracker', async () => {
  await writeFile(tracker, '{"version":1,"projects":[],"cards":[{"id":"nope"}],"feed":[]}');
  const res = await fetch(`${base}/api/tracker`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not a valid tracker document/);
  await writeFile(tracker, 'definitely not json');
  assert.equal((await fetch(`${base}/api/tracker`)).status, 500);
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

test('GET answers 404 when the tracker is missing', async () => {
  const { rename: mv } = await import('node:fs/promises');
  await mv(tracker, `${tracker}.hidden`);
  try {
    assert.equal((await fetch(`${base}/api/tracker`)).status, 404);
  } finally {
    await mv(`${tracker}.hidden`, tracker);   // restore even on failure, or every later test cascades
  }
});

test('GET carries an ETag that tracks content, not time', async () => {
  const res = await fetch(`${base}/api/tracker`);
  const tag = res.headers.get('etag');
  assert.match(tag, /^"[0-9a-f]{16}"$/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await etag(), tag, 'unchanged content keeps the same ETag');

  const doc = seed();
  doc.cards[0].title = 'retitled';
  await put(doc);
  assert.notEqual(await etag(), tag, 'changed content changes the ETag');
  await put(seed());
});

test('PUT without If-Match is refused', async () => {
  const before = await readFile(tracker, 'utf8');
  const res = await fetch(`${base}/api/tracker`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(seed()),
  });
  assert.equal(res.status, 428);
  assert.match((await res.json()).error, /If-Match required/);
  assert.equal(await readFile(tracker, 'utf8'), before, 'nothing written');
});

test('a stale If-Match is refused with 409 and the winning document', async () => {
  // The loss path this card exists to close: the desk holds a snapshot from an
  // earlier GET while another writer commits, then PUTs over it.
  const stale = await etag();

  const winner = seed();
  winner.cards.push({
    id: 'TS-042', p: 'test', title: 'written by someone else', type: 'feature', pri: 'P2',
    effort: 'M', status: 'backlog', claude: null, branch: null, commit: null,
    created: '2026-07-02T00:00:00Z', pushed: null, shipped: null,
  });
  assert.equal((await put(winner)).status, 200);

  const loser = seed();
  loser.cards[0].title = 'stale desk snapshot';
  const res = await put(loser, stale);
  assert.equal(res.status, 409);

  const body = await res.json();
  assert.match(body.error, /changed since you read it/);
  assert.ok(body.tracker.cards.some((c) => c.id === 'TS-042'), '409 returns the document that won');
  assert.equal(res.headers.get('etag'), await etag(), 'and its current ETag');

  const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
  assert.ok(onDisk.cards.some((c) => c.id === 'TS-042'), 'the committed write survived');
  assert.equal(onDisk.cards[0].title, 'A card', 'the stale write was not applied');
  await put(seed());
});

test('retrying with the ETag from a 409 succeeds', async () => {
  const stale = await etag();
  const first = seed();
  first.cards[0].title = 'first';
  await put(first);

  const res = await put(seed(), stale);
  assert.equal(res.status, 409);
  const fresh = res.headers.get('etag');

  const retry = await put(seed(), fresh);
  assert.equal(retry.status, 200, 'the retry lands with the current ETag');
  assert.equal(retry.headers.get('etag'), await etag());
});

test('a second server on the same port fails loudly instead of dying silently', async () => {
  // The bug this guards: the old harness bound a fixed port, the spawn lost the
  // race, and the tests happily talked to the server that was already there.
  const taken = Number(new URL(base).port);
  const clash = spawn(process.execPath, [join(sandbox, 'shipward', 'serve.mjs')], {
    cwd: sandbox,
    env: { ...process.env, SHIPWARD_PORT: String(taken) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let said = '';
  clash.stderr.on('data', (d) => { said += d; });
  const code = await new Promise((r) => clash.once('exit', r));
  assert.equal(code, 1, 'a losing bind must exit non-zero');
  assert.match(said, /already in use/);
  assert.equal((await fetch(`${base}/api/tracker`)).status, 200, 'the first server is untouched');
});

test('unsupported methods are refused', async () => {
  assert.equal((await fetch(`${base}/api/tracker`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
