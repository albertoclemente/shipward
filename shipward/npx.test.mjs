// The npx entry. Run: node --test
//
// SW-083. The rule under test is one rule: a transient install (npx cache,
// pnpm store, bun cache) is never run in place — a durable copy is made at
// ~/.shipward/app first and everything delegates there, so the paths setup
// writes into committed files (SW-066) outlive the cache. A stable install
// runs in place, untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTransient, planArgs, ensureStable } from './npx.mjs';

/* ── what counts as a cache ──────────────────────────────── */

test('the npm exec cache is transient, a clone is not', () => {
  assert.equal(isTransient('/Users/x/.npm/_npx/abc123/node_modules/shipward'), true);
  assert.equal(isTransient('/Users/x/.npm/_cacache/tmp/shipward'), true);
  assert.equal(isTransient('/Users/x/.pnpm-store/v3/shipward'), true);
  assert.equal(isTransient('/Users/x/.bun/install/cache/shipward'), true);
  assert.equal(isTransient('/Users/x/projects/shipward'), false);
  assert.equal(isTransient('/usr/local/lib/node_modules/shipward'), false, 'a global install is a stable path');
});

/* ── command dispatch ────────────────────────────────────── */

test('named commands get their scripts, everything else passes through to the CLI', () => {
  assert.deepEqual(planArgs(['setup', '/some/repo', '--seed-from-branches']),
    { script: 'setup.mjs', args: ['/some/repo', '--seed-from-branches'] });
  assert.deepEqual(planArgs(['serve']), { script: 'serve.mjs', args: [] });
  assert.deepEqual(planArgs(['fleet-service', 'install']), { script: 'fleet-service.mjs', args: ['install'] });
  // A verb this file has never heard of still reaches the CLI untouched, so a
  // verb the CLI grows later needs no change here.
  assert.deepEqual(planArgs(['standup']), { script: 'cli.mjs', args: ['standup'] });
  assert.deepEqual(planArgs(['done', 'SW-001', '--note', 'x']),
    { script: 'cli.mjs', args: ['done', 'SW-001', '--note', 'x'] });
});

/* ── the durable copy ────────────────────────────────────── */

// A fake package whose path contains the one segment that makes it a cache.
const stagedCache = async (version) => {
  const base = await mkdtemp(join(tmpdir(), 'shipward-npx-'));
  const pkg = join(base, '_npx', 'deadbeef', 'node_modules', 'shipward');
  await mkdir(join(pkg, 'shipward'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'shipward', version }));
  await writeFile(join(pkg, 'shipward', 'cli.mjs'), '// stand-in\n');
  // The two things a copy from a CLONE must never drag along.
  await mkdir(join(pkg, '.git'), { recursive: true });
  await writeFile(join(pkg, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(pkg, '.shipward'), { recursive: true });
  await writeFile(join(pkg, '.shipward', 'tracker.json'), '{"cards":[]}');
  // The one .shipward file that IS product, not board: setup copies it into
  // every onboarded repo.
  await writeFile(join(pkg, '.shipward', 'schema.json'), '{}');
  return { base, pkg };
};

test('a stable path is returned as-is and nothing is written', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shipward-home-'));
  const clone = await mkdtemp(join(tmpdir(), 'shipward-clone-'));
  assert.equal(await ensureStable({ home, from: clone }), clone);
  await assert.rejects(stat(join(home, '.shipward')), 'no install directory appears for a stable run');
});

test('a transient path is copied to ~/.shipward/app and that path is returned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shipward-home-'));
  const { pkg } = await stagedCache('0.1.0');
  const app = await ensureStable({ home, from: pkg });
  assert.equal(app, join(home, '.shipward', 'app'));
  assert.equal(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).version, '0.1.0');
  await stat(join(app, 'shipward', 'cli.mjs'));
});

test('the copy carries the schema but neither a git dir nor a board', async () => {
  // From the real npm tarball only the schema exists; from a clone all three
  // do, and a clone's OWN tracker landing in every user's install would be
  // the SW-033 incident shipped as a feature.
  const home = await mkdtemp(join(tmpdir(), 'shipward-home-'));
  const { pkg } = await stagedCache('0.1.0');
  const app = await ensureStable({ home, from: pkg });
  await assert.rejects(stat(join(app, '.git')), 'the git dir must not be copied');
  await assert.rejects(stat(join(app, '.shipward', 'tracker.json')), 'the board must not be copied');
  await stat(join(app, '.shipward', 'schema.json'));
});

test('the same version is not copied twice', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shipward-home-'));
  const { pkg } = await stagedCache('0.1.0');
  const app = await ensureStable({ home, from: pkg });
  const marker = join(app, 'left-by-first-install');
  await writeFile(marker, 'still here means no re-copy\n');
  await ensureStable({ home, from: pkg });
  await stat(marker);
});

test('a different version re-copies — in either direction', async () => {
  // `npx shipward@0.1.2` after 0.2.0 is installed should yield the version
  // asked for, not silently keep the newer one.
  const home = await mkdtemp(join(tmpdir(), 'shipward-home-'));
  const first = await stagedCache('0.2.0');
  const app = await ensureStable({ home, from: first.pkg });
  const marker = join(app, 'left-by-first-install');
  await writeFile(marker, 'gone means the install was replaced\n');
  const older = await stagedCache('0.1.2');
  await ensureStable({ home, from: older.pkg });
  assert.equal(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).version, '0.1.2');
  await assert.rejects(stat(marker), 'the previous install is replaced, not merged into');
});
