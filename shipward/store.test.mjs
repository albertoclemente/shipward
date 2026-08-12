// Cross-process concurrency for the shared tracker store. Run: node --test
//
// The desk-core review proved that a same-process write race ships silently.
// These tests spawn real child processes, because that is the case an
// in-process queue cannot cover and the MCP server will create.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, lstat, utimes, unlink } from 'node:fs/promises';
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

/* ── the feed archive (SW-027) ───────────────────────────── */
// The store reads its paths at import time, so these run in a child process
// pointed at the sandbox, same as the concurrency tests.

const inChild = (code) => run(process.execPath, ['--input-type=module', '-e', code],
  { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

const feedEntry = (n) => ({
  t: new Date(Date.UTC(2026, 6, 1, 0, 0, n)).toISOString(),
  p: 'test', msg: `entry ${n}`, by: 'claude',
});

test('entries trimmed by the cap land in the archive, oldest first', async () => {
  // Fill to the cap, then push 5 more through mutate — normalize() trims.
  const d = seed();
  d.feed = Array.from({ length: 200 }, (_, i) => feedEntry(200 - i)); // newest first
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  await inChild(`
    import { mutate } from ${JSON.stringify(STORE)};
    await mutate((doc) => {
      for (let n = 201; n <= 205; n++) {
        doc.feed.unshift({ t: new Date(Date.UTC(2026, 6, 1, 0, 0, n)).toISOString(), p: 'test', msg: 'entry ' + n, by: 'claude' });
      }
      return doc;
    });`);

  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.feed.length, 200, 'the cap still holds');
  assert.equal(doc.feed[0].msg, 'entry 205');

  const lines = (await readFile(join(sandbox, '.shipward', 'feed-archive.jsonl'), 'utf8'))
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.msg), ['entry 1', 'entry 2', 'entry 3', 'entry 4', 'entry 5'],
    'exactly the trimmed entries, oldest first');

  // The union of tracker + archive is everything ever written.
  const all = new Set([...doc.feed, ...lines].map((f) => f.msg));
  assert.equal(all.size, 205, 'no entry exists nowhere');
});

test('a write that drops nothing writes no archive', async () => {
  await inChild(`
    import { mutate } from ${JSON.stringify(STORE)};
    await mutate((doc) => { doc.feed.unshift({ t: '2026-07-01T00:00:00Z', p: 'test', msg: 'one', by: 'user' }); return doc; });`);
  await assert.rejects(stat(join(sandbox, '.shipward', 'feed-archive.jsonl')),
    'no drops, no file — an empty archive would look like a bug');
});

test('replace() archives what the incoming body no longer carries', async () => {
  const d = seed();
  d.feed = [feedEntry(2), feedEntry(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  // The desk PUTs a doc whose feed lost entry 1 (its own feedAdd sliced it).
  await inChild(`
    import { replace } from ${JSON.stringify(STORE)};
    const doc = ${JSON.stringify(d)};
    doc.feed = [doc.feed[0]];
    await replace(doc);`);

  const lines = (await readFile(join(sandbox, '.shipward', 'feed-archive.jsonl'), 'utf8'))
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.msg), ['entry 1']);
});

test('an unwritable archive does not take the tracker write with it', async () => {
  const d = seed();
  d.feed = [feedEntry(2), feedEntry(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  // A directory where the archive file should be makes appendFile fail.
  await mkdir(join(sandbox, '.shipward', 'feed-archive.jsonl'));

  const { stderr } = await inChild(`
    import { mutate } from ${JSON.stringify(STORE)};
    await mutate((doc) => { doc.feed = [doc.feed[0]]; return doc; });`);

  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.feed.length, 1, 'the tracker write must land regardless');
  assert.match(stderr, /could not archive 1 feed entry/, 'but not silently');
});

/* ── structured note validation (SW-028) ─────────────────── */

test('validate accepts both note forms and rejects malformed entries', async () => {
  const base = seed();
  const mk = (note) => JSON.parse(JSON.stringify({ ...base, cards: [{ ...card(1), note }] }));
  const v = async (doc) => {
    const { validate } = await import(STORE);
    return validate(doc);
  };

  assert.equal(await v(mk('plain prose')), null);
  assert.equal(await v(mk([])), null);
  assert.equal(await v(mk([{ t: '2026-07-28T10:00:00Z', text: 'x' }])), null);
  assert.equal(await v(mk([{ t: '2026-07-28T10:00:00Z', kind: 'finding', text: 'x', resolves: 'TS-001' }])), null);

  assert.match(await v(mk(42)), /note must be a string or an array/);
  assert.match(await v(mk([{ t: '2026-07-28T10:00:00Z' }])), /text must be a string/);
  assert.match(await v(mk([{ text: 'x' }])), /t must be a date-time/);
  assert.match(await v(mk([{ t: 'yesterday-ish', text: 'x' }])), /t must be a date-time/);
  assert.match(await v(mk([{ t: '2026-07-28T10:00:00Z', text: 'x', kind: 'vibe' }])), /kind is invalid/);
  assert.match(await v(mk([{ t: '2026-07-28T10:00:00Z', text: 'x', resolves: 'not-an-id' }])), /resolves must be a card id/);
});

/* ── the card-loss warning (SW-035) ──────────────────────── */

const manyCards = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

test('a write that drops most of the board says so on stderr, and still lands', async () => {
  const d = { ...seed(), cards: manyCards(8) };
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const { stderr } = await inChild(`
    import { replace } from ${JSON.stringify(STORE)};
    const doc = ${JSON.stringify({ ...seed(), cards: [] })};
    doc.cards = [${JSON.stringify(card(1))}];
    await replace(doc);`);
  assert.match(stderr, /WARNING — this write drops 7 of 8 cards/);
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.cards.length, 1, 'a warning, never a gate — the write lands');
});

test('ordinary edits and small boards stay quiet', async () => {
  // Deleting one card from a real board is an edit, not an event.
  const d = { ...seed(), cards: manyCards(8) };
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const one = await inChild(`
    import { mutate } from ${JSON.stringify(STORE)};
    await mutate((doc) => { doc.cards = doc.cards.slice(0, 7); return doc; });`);
  assert.doesNotMatch(one.stderr, /WARNING/);

  // And a tiny board being emptied is below the floor — the desk's own tests
  // replace 1-2 card seeds constantly. Listen for the card-loss warning
  // SPECIFICALLY: the hand reseed two lines up is an unlocked rewrite of a
  // journaled board, which SW-059 rightly announces — a different warning,
  // about a different thing.
  const small = { ...seed(), cards: manyCards(2) };
  await writeFile(tracker, JSON.stringify(small, null, 2) + '\n');
  const tiny = await inChild(`
    import { replace } from ${JSON.stringify(STORE)};
    await replace(${JSON.stringify(seed())});`);
  assert.doesNotMatch(tiny.stderr, /drops \d+ of \d+ cards/);
});

test('mutate is guarded too — a callback that eats the board is announced', async () => {
  const d = { ...seed(), cards: manyCards(6) };
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  const { stderr } = await inChild(`
    import { mutate } from ${JSON.stringify(STORE)};
    await mutate((doc) => { doc.cards = []; return doc; });`);
  assert.match(stderr, /drops 6 of 6 cards/);
});

/* ── the notes sidecar (SW-039) ────────────────────────────────
   Note text was 68-73% of every tracker measured, is append-only by protocol,
   and cards are never deleted — so the board file grew without bound. Entries
   now live in .shipward/notes.jsonl and the store is the only code that knows. */

const notesPath = () => join(sandbox, '.shipward', 'notes.jsonl');
const notesLines = async () => (await readFile(notesPath(), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const carded = (n, over = {}) => ({ ...card(n), ...over });

// The existing withStore(), with the store already imported as `store`.
const withStore = (body) => inChild(`import * as store from ${JSON.stringify(STORE)};\n${body}`);

test('the first ordinary write migrates inline notes into the sidecar', async () => {
  // No flag day and no migration step: a tracker that has never been split has
  // every entry "missing" from the sidecar, so the first write moves them all.
  const d = seed();
  d.cards = [carded(1, { note: [{ t: '2026-07-02T00:00:00Z', kind: 'finding', text: 'the lock broke' }] })];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  await withStore('await store.mutate((doc) => doc);');

  const onDisk = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(onDisk.cards[0].note, undefined, 'the board file carries no note text at all');
  assert.deepEqual(await notesLines(), [
    { card: 'TS-001', t: '2026-07-02T00:00:00Z', kind: 'finding', text: 'the lock broke' },
  ], 'and the sidecar carries it, keyed by card');

  const { stdout } = await withStore('const { doc } = await store.readRaw(); process.stdout.write(JSON.stringify(doc.cards[0].note));');
  assert.deepEqual(JSON.parse(stdout), [{ t: '2026-07-02T00:00:00Z', kind: 'finding', text: 'the lock broke' }],
    'and a reader still sees exactly what it saw before the split');
});

test('a legacy prose note migrates as segments, stamped with the card clock', async () => {
  const d = seed();
  d.cards = [carded(1, { note: 'SPEC CAP-4. Split from SW-001. || SHIPPED: the table renders.' })];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  await withStore('await store.mutate((doc) => doc);');
  assert.deepEqual(await notesLines(), [
    { card: 'TS-001', t: '2026-07-01T00:00:00Z', text: 'SPEC CAP-4. Split from SW-001.' },
    { card: 'TS-001', t: '2026-07-01T00:00:00Z', text: 'SHIPPED: the table renders.' },
  ], 'hand-edited prose is still supported, and converts on the way out');
});

test('re-appending an entry the sidecar already holds does not double it', async () => {
  // The write order is notes first, tracker second, so a tracker write that
  // fails leaves entries already durable. The next attempt re-appends them, and
  // that must be a no-op rather than a duplicated memory.
  const d = seed();
  d.cards = [carded(1, { note: [{ t: '2026-07-02T00:00:00Z', text: 'once' }] })];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  await withStore('await store.mutate((doc) => doc);');
  await withStore('await store.mutate((doc) => doc);');
  await withStore('const { doc } = await store.readRaw(); await store.replace(doc);');

  assert.equal((await notesLines()).length, 1, 'one entry, however many writes touched it');
});

test('an entry the incoming document dropped is kept, not deleted', async () => {
  // The sidecar can gain memory it should not have; it must never lose memory
  // it should. Notes are append-only by protocol and cards are never deleted,
  // so a vanished entry is a stale base or a caller mistake.
  const d = seed();
  d.cards = [carded(1, { note: [{ t: '2026-07-02T00:00:00Z', text: 'the finding' }] })];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  await withStore('await store.mutate((doc) => doc);');

  await withStore('await store.mutate((doc) => { doc.cards[0].note = []; return doc; });');

  assert.equal((await notesLines()).length, 1, 'the sidecar still holds it');
  const { stdout } = await withStore('const { doc } = await store.readRaw(); process.stdout.write(String(doc.cards[0].note.length));');
  assert.equal(stdout, '1', 'and the next read hands it back');
});

test('a malformed sidecar line is skipped and counted, never fatal', async () => {
  const d = seed();
  d.cards = [carded(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  await writeFile(notesPath(), [
    '{"card":"TS-001","t":"2026-07-02T00:00:00Z","text":"good one"}',
    'not json at all',
    '{"card":"TS-001","text":"no timestamp"}',
    '',
  ].join('\n') + '\n');

  const { stdout, stderr } = await withStore(
    'const { doc } = await store.readRaw(); process.stdout.write(JSON.stringify(doc.cards[0].note));',
  );
  assert.deepEqual(JSON.parse(stdout), [{ t: '2026-07-02T00:00:00Z', text: 'good one' }],
    'the readable entry survives');
  assert.match(stderr, /skipped 2 unreadable lines/, 'and the loss is reported, never silent');
});

test('a sidecar entry the schema rejects fails the read loudly', async () => {
  // The sidecar is a second file a human can edit. An entry with an invalid
  // kind used to be impossible; now it has its own door into every reader.
  const d = seed();
  d.cards = [carded(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');
  await writeFile(notesPath(), '{"card":"TS-001","t":"2026-07-02T00:00:00Z","kind":"nonsense","text":"x"}\n');

  await assert.rejects(
    withStore('await store.readRaw();'),
    (err) => /holds an entry the tracker schema rejects/.test(err.stderr),
    'the reader refuses rather than passing an invalid kind to standup and recall',
  );
});

test('the etag moves when only a note changed', async () => {
  // The desk's If-Match has to notice a note that landed as surely as a card
  // that moved, and after SW-039 those live in different files.
  const d = seed();
  d.cards = [carded(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const tag = async () => (await withStore('const { etag } = await store.readRaw(); process.stdout.write(etag);')).stdout;
  const before = await tag();
  await withStore(`await store.mutate((doc) => {
    doc.cards[0].note = [{ t: '2026-07-02T00:00:00Z', text: 'something learned' }];
    return doc;
  });`);
  assert.notEqual(await tag(), before, 'a board whose memory changed is not the same board');
});

test('a board with no notes never creates the sidecar', async () => {
  // Nine of the ten onboarded repos start here, and an empty file in every one
  // of them is nine files that say nothing.
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  await assert.rejects(stat(notesPath()), { code: 'ENOENT' });
});

test('the sidecar preserves every field an entry carries, not a known list', async () => {
  // The first version of noteRecord copied t/text/kind/resolves. SW-053 landed
  // `sha` and `dirty` on entries in the same week and the sidecar dropped them
  // silently — caught only because SW-053 had its own round-trip test. A field
  // list here is a slow leak, so this asserts on a field nobody has invented.
  const d = seed();
  d.cards = [carded(1)];
  await writeFile(tracker, JSON.stringify(d, null, 2) + '\n');

  const entry = {
    t: '2026-07-02T00:00:00Z', kind: 'evidence', text: 'node --test passed',
    sha: 'abc1234', dirty: true, somethingAddedLater: { nested: 1 },
  };
  await withStore(`await store.mutate((doc) => {
    doc.cards[0].note = [${JSON.stringify(entry)}];
    return doc;
  });`);

  assert.deepEqual(await notesLines(), [{ card: 'TS-001', ...entry }], 'written whole');
  const { stdout } = await withStore('const { doc } = await store.readRaw(); process.stdout.write(JSON.stringify(doc.cards[0].note));');
  assert.deepEqual(JSON.parse(stdout), [entry], 'and read back whole');
});

/* ── the write rev + git-revert detection (SW-059) ────────────
   Two agent sessions share one checkout. A done() committed the board through
   the lock; a `git checkout` in the same second rewrote the file from the
   index — git never takes the lock, so the loss was silent on both sides.
   The store cannot prevent that; it can notice: every write stamps a rev that
   only it may raise and journals it to an untracked .shipward/last-write.json,
   and a board whose rev went DOWN is announced. Detect and say so, never
   auto-restore. */

const journalPath = () => join(sandbox, '.shipward', 'last-write.json');

test('every write stamps a rev the store owns; a no-op leaves it alone', async () => {
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  let onDisk = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(onDisk.rev, 1, 'the first write seeds rev on a legacy board');

  await withStore('const { doc } = await store.readRaw(); await store.replace(doc);');
  onDisk = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(onDisk.rev, 2, 'replace() bumps it the same as mutate()');

  await withStore('await store.mutate(() => null);');
  onDisk = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(onDisk.rev, 2, 'a deliberate no-op writes nothing, so it bumps nothing');

  const journal = JSON.parse(await readFile(journalPath(), 'utf8'));
  assert.equal(journal.rev, 2, 'the journal remembers the last committed rev');
  const { stdout } = await withStore('const { etag } = await store.readRaw(); process.stdout.write(etag);');
  assert.equal(journal.etag, stdout, 'and the etag of the state it committed');
  assert.ok(Number.isInteger(journal.pid), 'with the writer pid for forensics');
  assert.ok(!Number.isNaN(Date.parse(journal.at)), 'and when, ISO-stamped');
});

test('a board rewritten to a lower rev warns on read and is recorded by the next write', async () => {
  // Exactly what `git checkout` does: the store commits rev 2, git puts the
  // rev-1 bytes back from the index without ever taking the lock.
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  const oldBytes = await readFile(tracker, 'utf8');                     // the rev-1 board
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(2))}); return doc; });`);
  await writeFile(tracker, oldBytes);                                   // ← the checkout

  const read = await withStore('const { doc } = await store.readRaw(); process.stdout.write(String(doc.rev));');
  assert.equal(read.stdout, '1', 'the read still succeeds — checking out an old board is legitimate');
  assert.match(read.stderr, /WARNING — the board went BACKWARDS/, 'but it is never silent');
  assert.match(read.stderr, /at rev 1 but rev 2 was committed/, 'it names both revs');
  assert.match(read.stderr, /git checkout or reset/, 'and the likely culprit');
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).rev, 1, 'and a read NEVER writes');

  const write = await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(3))}); return doc; });`);
  assert.match(write.stderr, /went BACKWARDS/, 'the writer names it too');
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.ok(doc.rev > 2, `the new write must land past the journal, got rev ${doc.rev}`);
  assert.match(doc.feed[0].msg, /git rewrote the board/, 'one durable feed entry records it');
  assert.match(doc.feed[0].msg, /rev fell from 2/, 'with the rev that vanished');
  assert.equal(doc.feed[0].by, undefined, 'attributed to neither claude nor user — git did it');
  assert.equal(JSON.parse(await readFile(journalPath(), 'utf8')).rev, doc.rev, 'journal caught up');

  const after = await withStore('await store.readRaw();');
  assert.doesNotMatch(after.stderr, /BACKWARDS/, 'so the write retires the warning');
});

test('a legacy board with no rev and no journal reads clean', async () => {
  const r = await withStore('const { doc } = await store.readRaw(); process.stdout.write(String(doc.rev));');
  assert.equal(r.stdout, 'undefined', 'rev is absent on a read, never invented');
  assert.doesNotMatch(r.stderr, /WARNING|BACKWARDS/, 'absence of history is not an accusation');
});

test('a fresh clone — rev on disk, no journal — makes no claim', async () => {
  await writeFile(tracker, JSON.stringify({ ...seed(), rev: 7 }, null, 2) + '\n');
  const r = await withStore('const { doc } = await store.readRaw(); process.stdout.write(String(doc.rev));');
  assert.equal(r.stdout, '7');
  assert.doesNotMatch(r.stderr, /WARNING|BACKWARDS/, 'a missing journal is how every clone starts');

  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).rev, 8, 'and the next write climbs from the file');
});

test('an unwritable journal never takes the board write with it', async () => {
  await mkdir(journalPath());                    // a directory where the file should be
  const { stderr } = await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.cards.length, 1, 'the write landed');
  assert.equal(doc.rev, 1, 'rev stamped from the file alone');
  assert.match(stderr, /could not journal this write/, 'but the failure is not silent');
});

test('a PUT carrying a stale rev cannot lower the stored one', async () => {
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(1))}); return doc; });`);
  await withStore(`await store.mutate((doc) => { doc.cards.push(${JSON.stringify(card(2))}); return doc; });`);

  // The desk PUTs whole documents; this base predates both writes above.
  await withStore(`await store.replace(${JSON.stringify({ ...seed(), rev: 1, cards: [card(9)] })});`);
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.equal(doc.cards.length, 1, 'the replacement itself is honoured');
  assert.equal(doc.rev, 3, 'but its stale rev is not — the store stamps past everything seen');
});

test('validate: rev is absent or a non-negative integer, nothing else', async () => {
  const { validate } = await import(STORE);
  assert.equal(validate(seed()), null, 'absent — every board written before SW-059');
  assert.equal(validate({ ...seed(), rev: 0 }), null);
  assert.equal(validate({ ...seed(), rev: 41 }), null);
  assert.match(validate({ ...seed(), rev: -1 }), /rev must be a non-negative integer/);
  assert.match(validate({ ...seed(), rev: 1.5 }), /rev must be a non-negative integer/);
  assert.match(validate({ ...seed(), rev: '3' }), /rev must be a non-negative integer/);
});

/* ── one remover per lock (SW-071) ───────────────────────── */

test('a breaker acting on a stale observation cannot carry off a live lock', async () => {
  // The race CI found, made deterministic. B condemns the dead lock; A breaks
  // it and publishes; B then acts on its now-stale observation. Under the old
  // rename-then-check break, B moved A's live lock away and — if the path had
  // been taken meanwhile — could not give it back, and A's write was refused.
  //
  // Now removal is gated on hard-linking the exact inode that was condemned, so
  // B's claim is for an inode that is no longer at the path and it must abort.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  const { ino: condemned } = await lstat(lock);

  // A takes the lock for real, and holds it.
  const slow = run(process.execPath, ['--input-type=module', '-e',
    `import { mutate } from ${JSON.stringify(STORE)};
     await mutate(async (doc) => {
       await new Promise((r) => setTimeout(r, 3000));
       doc.cards.push(${JSON.stringify(card(1))}); return doc;
     });`,
  ], { env: { ...process.env, SHIPWARD_TRACKER: tracker } });

  // Wait until the lock at the path is a DIFFERENT inode — A has published.
  for (let i = 0; i < 200; i++) {
    const st = await lstat(lock).catch(() => null);
    if (st && st.ino !== condemned) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const live = await lstat(lock);
  assert.notEqual(live.ino, condemned, 'A should hold a lock of its own by now');

  // B acts on the stale observation: claim the inode it condemned.
  const claim = `${lock}.claim.${condemned}`;
  await writeFile(claim, String(Date.now()));
  // This is the check that saves A: the claim is for the inode B condemned, and
  // the path no longer names it, so a correct breaker drops the claim and
  // leaves the live lock alone.
  assert.notEqual(live.ino, condemned, 'the path holds a different lock than the one claimed');
  await unlink(claim);

  await slow;
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.deepEqual(doc.cards.map((c) => c.id), ['TS-001'], "A's write must survive");
});

test('a claim left behind by a crash does not make the lock unbreakable', async () => {
  // The cost of gating removal on a claim: a process that dies between winning
  // one and unlinking the lock would wedge it forever. An old claim is the only
  // evidence of that, so it is breakable in turn.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  const { ino } = await lstat(lock);

  const claim = `${lock}.claim.${ino}`;
  await writeFile(claim, String(Date.now()));
  await utimes(claim, old, old);          // a claim nobody has finished with

  await appendInChild(1);
  const doc = JSON.parse(await readFile(tracker, 'utf8'));
  assert.deepEqual(doc.cards.map((c) => c.id), ['TS-001'], 'the write must still land');
});

test('a fresh claim is respected — two breakers do not both remove one lock', async () => {
  // The other side of the same rule: a claim that is NOT stale means somebody
  // is mid-removal, and a second breaker must leave it alone rather than
  // unlink a lock it does not own the removal of.
  const lock = `${tracker}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 999999, token: 'dead', at: 0 }));
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  const { ino } = await lstat(lock);

  // Its own file with its own clock — which is the point. A hard link of the
  // lock would inherit the lock's mtime, and a stale lock's claim would be born
  // stale; that was the first version of this fix, and this test is what found
  // it.
  const claim = `${lock}.claim.${ino}`;
  await writeFile(claim, String(Date.now()));

  // A writer arrives while the claim is held. It must not remove the lock; it
  // waits, and once the claim ages out it proceeds — so this is bounded, not a
  // deadlock, which is the property that matters.
  const write = appendInChild(1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 0,
    'must not enter while another remover holds the claim');
  await write;
  assert.equal(JSON.parse(await readFile(tracker, 'utf8')).cards.length, 1,
    'and must get in once the claim is provably abandoned');
});
