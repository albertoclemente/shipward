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
const PORT = 4749;                       // not 4747 — never touch a running desk
const base = `http://127.0.0.1:${PORT}`;
let sandbox, tracker, proc;

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
  await cp(join(HERE, 'serve.mjs'), join(sandbox, 'shipward', 'serve.mjs'));
  await cp(join(HERE, 'public'), join(sandbox, 'shipward', 'public'), { recursive: true });

  proc = spawn(process.execPath, [join(sandbox, 'shipward', 'serve.mjs')], {
    stdio: 'ignore', env: { ...process.env, PORT: String(PORT) },
  });
  // serve.mjs hard-codes 4747; rewrite the port for the sandbox copy instead.
  proc.kill();
  const src = (await readFile(join(HERE, 'serve.mjs'), 'utf8')).replace('const PORT = 4747;', `const PORT = ${PORT};`);
  await writeFile(join(sandbox, 'shipward', 'serve.mjs'), src);
  proc = spawn(process.execPath, [join(sandbox, 'shipward', 'serve.mjs')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/tracker`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => proc?.kill());

const put = (body) => fetch(`${base}/api/tracker`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
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

test('concurrent writes never corrupt the file', async () => {
  // Reproduces the original defect: overlapping PUTs shared one temp path and
  // truncated each other, leaving unparseable JSON.
  for (let round = 0; round < 15; round++) {
    const docs = Array.from({ length: 6 }, (_, i) => {
      const d = seed();
      d.cards[0].title = `concurrent ${round}-${i}`.padEnd(500, 'x');
      return d;
    });
    const codes = await Promise.all(docs.map((d) => put(d).then((r) => r.status)));
    assert.ok(codes.every((c) => c === 200), `round ${round}: ${codes}`);
    const raw = await readFile(tracker, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `round ${round} left unparseable JSON`);
  }
  const leftovers = (await readdir(join(sandbox, '.shipward'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no orphan temp files');
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

test('unsupported methods are refused', async () => {
  assert.equal((await fetch(`${base}/api/tracker`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
