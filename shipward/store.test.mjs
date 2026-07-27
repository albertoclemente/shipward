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
const sandboxes = [];        // beforeEach reassigns; after() must clean them all

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
  sandboxes.push(sandbox);
  await mkdir(join(sandbox, '.shipward'));
  tracker = join(sandbox, '.shipward', 'tracker.json');
  await writeFile(tracker, JSON.stringify(seed(), null, 2) + '\n');
});

after(() => Promise.all(sandboxes.map((s) => rm(s, { recursive: true, force: true }).catch(() => {}))));

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

test('a live holder is waited for however long it takes', async () => {
  // The old lock stamped its mtime once and aged out at 5s, so a slow-but-alive
  // holder had its lock stolen and its write silently overwritten.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }));
  const pending = appendInChild(1);
  await new Promise((r) => setTimeout(r, 800));
  const waited = JSON.parse(await readFile(tracker, 'utf8')).cards.length === 0;
  const { unlink } = await import('node:fs/promises');
  await unlink(lock);
  await pending;
  assert.ok(waited, 'must not enter while a live pid holds the lock');
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
});

test('a slow mutation keeps its lock and never loses its write', async () => {
  // REGRESSION: a 6s callback used to have its lock broken at 5s; the breaker
  // read the pre-mutation doc and both processes exited 0 with one write gone.
  const slow = run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     await mutate(async (doc) => {
       await new Promise((r) => setTimeout(r, 6000));
       doc.cards.push(${JSON.stringify(card(1))}); return doc;
     });`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  await new Promise((r) => setTimeout(r, 1000));
  const fast = appendInChild(2);
  await Promise.all([slow, fast]);

  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  const ids = doc.cards.map((c) => c.id).sort();
  assert.deepEqual(ids, ['TS-001', 'TS-002'], 'both writes must survive');
});

test('contended breaking of one stale lock still admits only one writer', async () => {
  // REGRESSION: detect-and-break was three non-atomic steps, so four processes
  // each unlinked the previous winner's fresh lock and all four entered.
  // Measured 9/25 trials losing writes before the rename-based break.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);

  const N = 4;
  await Promise.all(Array.from({ length: N }, (_, i) => appendInChild(i + 1)));

  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.cards.length, N, 'every writer must land despite the contended break');
  assert.equal(new Set(doc.cards.map((c) => c.id)).size, N);
});

test('a lock whose mtime is in the future is not read as a corpse', async () => {
  // REGRESSION, and the subtlest one here. isStale() used to judge the lock from
  // TWO observations of the path — readHolder() then lstat() — so a reader that
  // hit the lock in its momentary absence between one release and the next
  // publish got holder=null and then measured a DIFFERENT, brand-new lock. That
  // lock tripped `age < 0 → stale`, because st.mtimeMs keeps sub-millisecond
  // precision while Date.now() truncates: 1085 of 2000 freshly created locks
  // measured as up to 0.62ms in the future. Over half of all newborn locks were
  // therefore breakable, and the break took a LIVE holder's lock with it.
  // Cost: ~1 silently lost write per 900 under sustained contention.
  const lock = `${tracker}.lock`;
  await writeFile(lock, '');                        // unparsable, as in the race
  const { utimes, unlink } = await import('node:fs/promises');
  const future = new Date(Date.now() + 1000);
  await utimes(lock, future, future);

  const pending = appendInChild(1);
  await new Promise((r) => setTimeout(r, 600));
  const waited = JSON.parse(await readFile(tracker, 'utf8')).cards.length === 0;
  await unlink(lock);
  await pending;

  assert.ok(waited, 'a lock dated in the future must be treated as new, not dead');
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1, 'and the write still lands');
});

test('the sweep spares a live process\'s in-flight temp file', async () => {
  // REGRESSION: breakLock() swept every matching name, so it deleted the
  // atomic-write temp of a LIVE holder mid-write — that holder's chmod then
  // failed ENOENT. Only a dead pid's leftovers may be collected.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);

  const dir = join(sandbox, '.shipward');
  const mine = join(dir, `tracker.json.${process.pid}.abcd-ef01.tmp`);
  const dead = join(dir, 'tracker.json.999999.abcd-ef02.tmp');
  await writeFile(mine, 'in flight');
  await writeFile(dead, 'orphan');

  await appendInChild(1);                            // breaks the stale lock, sweeps

  await stat(mine);                                  // throws if it was swept
  await assert.rejects(stat(dead), 'a dead writer\'s orphan must be collected');
});

test('a holder that loses its lock mid-write writes nothing and says so', async () => {
  // Defence in depth. Every known way to lose a lock is closed; if one is ever
  // reopened, the symptom must be a loud error, not a vanished card.
  const stolen = run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     import { unlink, writeFile } from 'node:fs/promises';
     const lock = process.env.SHIPWARD_TRACKER + '.lock';
     await mutate(async (doc) => {
       await unlink(lock);
       await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() }));
       doc.cards.push(${JSON.stringify(card(1))});
       return doc;
     });`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  await assert.rejects(stolen, /lost the tracker lock/);
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 0, 'nothing was written');
});

test('a dangling symlink at the lock path does not spin forever', async () => {
  // REGRESSION: open(wx) returned EEXIST, stat followed the link and threw
  // ENOENT, and the catch looped with no deadline check and no sleep — 100% CPU
  // and acquire() never returned.
  const { symlink } = await import('node:fs/promises');
  await symlink(join(sandbox, 'nonexistent-target'), `${tracker}.lock`);
  const started = Date.now();
  await appendInChild(1);                        // must complete, not hang
  assert.ok(Date.now() - started < 20_000, 'must not spin');
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
});

test('the tracker keeps its file mode across a write', async () => {
  const { chmod, stat: fstat } = await import('node:fs/promises');
  await chmod(tracker, 0o600);
  await appendInChild(1);
  assert.equal((await fstat(tracker)).mode & 0o777, 0o600, 'rename must not reset the mode');
});

test('a feed at the cap truncates instead of freezing the tracker', async () => {
  // REGRESSION: validate() rejected feed.length > 200, so once the feed filled,
  // every card write (each of which appends an entry) failed permanently.
  const doc = seed();
  doc.feed = Array.from({ length: 200 }, (_, i) => ({
    t: `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}Z`, p: 'test', msg: `e${i}`, by: 'user',
  }));
  await writeFile(tracker, JSON.stringify(doc, null, 2) + '\n');

  await run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     await mutate((d) => {
       d.cards.push(${JSON.stringify(card(1))});
       d.feed.unshift({ t: new Date().toISOString(), p: 'test', msg: 'one more', by: 'claude' });
       return d;
     });`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  const after = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(after.feed.length, 200, 'truncated to the cap');
  assert.equal(after.feed[0].msg, 'one more', 'newest kept, oldest dropped');
  assert.equal(after.cards.length, 1, 'the card write went through');
});

test('a callback that mutates in place but forgets to return is an error', async () => {
  const before = await readFile(tracker, 'utf8');
  await assert.rejects(
    run(process.execPath, ['--input-type=module', '-e',
      `import { mutate } from ${JSON.stringify(STORE)};
       await mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); });`,
    ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } }),
    /changed the document in place but returned nothing/,
  );
  assert.equal(await readFile(tracker, 'utf8'), before);
});

test('a callback returning a falsy non-null value is an error, not a silent no-op', async () => {
  await assert.rejects(
    run(process.execPath, ['--input-type=module', '-e',
      `import { mutate } from ${JSON.stringify(STORE)};
       await mutate(() => false);`,
    ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } }),
    /must return a document object or null/,
  );
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


/* -- after the lock edge-case review (SW-019) --------------- */

test('a lock held by a live pid is breakable once it stops heartbeating', async () => {
  // Liveness made a lock unbreakable FOREVER: one 24 hours old held by pid 1
  // never became breakable, and the lock lives in the working directory, so it
  // survives a reboot after which that pid belongs to something else.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'stale-but-alive', at: 0 }));
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 6 * 60 * 1000);          // past LOCK_ABANDONED_MS
  await utimes(lock, old, old);

  await appendInChild(1);                                     // must not hang
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
});

test('a lock dated far in the future is not immortal', async () => {
  // "age < 0 means new" had no upper bound, so one backwards clock step froze
  // every existing lock permanently.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const { utimes } = await import('node:fs/promises');
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await utimes(lock, future, future);

  await appendInChild(1);
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1);
});

test('a dead holder costs seconds, not half a minute', async () => {
  // 30s per crash meant two crashes inside one waiter's deadline was a
  // guaranteed failure: 2 of 4 clean writers hard-failed.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 5000);
  await utimes(lock, old, old);

  const started = Date.now();
  await appendInChild(1);
  const waited = Date.now() - started;
  assert.ok(waited < 20000, `waited ${waited}ms on a provably dead holder`);
});

test('a nested mutate fails immediately instead of deadlocking for a minute', async () => {
  const nested = run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     await mutate(async (doc) => { await mutate((d) => d); return doc; });`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  const started = Date.now();
  await assert.rejects(nested, /already held by this process/);
  assert.ok(Date.now() - started < 20000, 'it used to wait the full lock timeout');
});

test('a grave left by a killed breaker is eventually collected', async () => {
  // Graves matched neither sweep pattern, so they accumulated forever.
  const grave = `${tracker}.lock.dead.abcdef01-2345-6789-abcd-ef0123456789`;
  await writeFile(grave, 'corpse');
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 120000);
  await utimes(grave, old, old);

  // Force a break, which is what runs the sweep.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  await utimes(lock, old, old);
  await appendInChild(1);

  await assert.rejects(stat(grave), 'the grave should have been swept');
});
