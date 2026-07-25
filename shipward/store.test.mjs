// Cross-process concurrency for the shared tracker store. Run: node --test
//
// The desk-core review proved that a same-process write race ships silently.
// These tests spawn real child processes, because that is the case an
// in-process queue cannot cover and the MCP server will create.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, 'tracker-store.mjs');
let sandbox, tracker;

const seed = () => ({
  version: 1,
  activeProject: 'test',
  projects: [{ id: 'test', name: 'Test', tag: 't', prefix: 'TS' }],
  cards: [],
  feed: [],
});

const card = (n) => ({
  id: `TS-${String(n).padStart(3, '0')}`, p: 'test', title: `card ${n}`,
  type: 'feature', pri: 'P2', effort: 'M', status: 'backlog',
  claude: null, branch: null, commit: null,
  created: '2026-07-01T00:00:00Z', pushed: null, shipped: null,
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'shipward-store-'));
  await mkdir(join(sandbox, '.shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

after(() => rm(sandbox, { recursive: true, force: true }).catch(() => {}));

// Each child appends one card through mutate(), in its own process.
const appendInChild = (n) => run(process.execPath, [
  '--input-type=module', '-e',
  `import { mutate } from ${JSON.stringify(STORE)};
   await mutate((doc) => { doc.cards.push(${JSON.stringify(card(n))}); return doc; });`,
], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

test('concurrent processes all land, none lost, file always valid', async () => {
  const N = 12;
  await Promise.all(Array.from({ length: N }, (_, i) => appendInChild(i + 1)));

  const raw = await readFile(tracker, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'tracker must still parse');
  const doc = JSON.parse(raw);
  assert.equal(doc.cards.length, N, 'every concurrent write must survive');
  const ids = new Set(doc.cards.map((c) => c.id));
  assert.equal(ids.size, N, 'no write clobbered another');
  for (let i = 1; i <= N; i++) assert.ok(ids.has(`TS-${String(i).padStart(3, '0')}`), `TS-${i} missing`);
});

test('no lock or temp files are left behind', async () => {
  await Promise.all([appendInChild(1), appendInChild(2), appendInChild(3)]);
  const leftovers = (await readdir(join(sandbox, '.shipward')))
    .filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
  assert.deepEqual(leftovers, [], `leftovers: ${leftovers}`);
});

test('a stale lock is broken rather than blocking forever', async () => {
  // A lock with an old mtime stands in for a holder that crashed.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, at: 0 }));
  const old = new Date(Date.now() - 60_000);
  const { utimes } = await import('node:fs/promises');
  await utimes(lock, old, old);

  await appendInChild(1);                       // must not hang
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
  await assert.rejects(stat(lock), 'the stale lock must be gone');
});

test('a fresh lock is waited for, not stolen', async () => {
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const started = Date.now();
  const pending = appendInChild(1);
  await new Promise((r) => setTimeout(r, 300));
  const stillWaiting = JSON.parse(await readFile(tracker, 'utf8')).cards.length === 0;
  const { unlink } = await import('node:fs/promises');
  await unlink(lock);                            // holder releases
  await pending;
  assert.ok(stillWaiting, 'writer must not proceed while the lock is fresh');
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
  assert.ok(Date.now() - started >= 300);
});

test('an invalid mutation result is refused and writes nothing', async () => {
  const before = await readFile(tracker, 'utf8');
  await assert.rejects(
    run(process.execPath, ['--input-type=module', '-e',
      `import { mutate } from ${JSON.stringify(STORE)};
       await mutate((doc) => { doc.cards.push({ id: 'not-an-id' }); return doc; });`,
    ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } }),
    /invalid tracker document|ValidationError/,
  );
  assert.equal(await readFile(tracker, 'utf8'), before, 'file untouched');
  await assert.rejects(stat(`${tracker}.lock`), 'lock released even on failure');
});

test('a no-op mutation writes nothing', async () => {
  const before = await stat(tracker);
  await new Promise((r) => setTimeout(r, 10));
  await run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     await mutate(() => null);`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });
  assert.equal((await stat(tracker)).mtimeMs, before.mtimeMs, 'mtime unchanged — no write happened');
});

test('read rejects a missing or corrupt tracker distinguishably', async () => {
  const probe = (code) => run(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  await writeFile(tracker, 'not json at all');
  await assert.rejects(
    probe(`import { read } from ${JSON.stringify(STORE)}; await read();`),
    /not valid JSON/,
  );

  await rm(tracker);
  await assert.rejects(
    probe(`import { read } from ${JSON.stringify(STORE)}; await read();`),
    /not found/,
  );
});
