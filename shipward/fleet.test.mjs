// Fleet tests. Run: node --test
//
// These spawn the real fleet over a staged root, which spawns real child
// desks — the contract is discovery, aggregation, isolation and cleanup, and
// only live processes can prove the last two.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let root, proc, base;

const card = (id, p, status, over = {}) => ({
  id, p, title: `card ${id}`, type: 'feature', pri: 'P2', effort: 'M',
  status, claude: status === 'claude' ? 'working' : null, branch: null, commit: null,
  note: '', created: '2026-07-01T00:00:00Z', pushed: null, shipped: null, ...over,
});

const trackerOf = (id, name, prefix, cards) => JSON.stringify({
  version: 1, activeProject: id,
  projects: [{ id, name, tag: 't', prefix }],
  cards,
  feed: [{ t: '2026-07-28T09:00:00Z', p: id, msg: `${name} says hello`, by: 'claude' }],
}, null, 2);

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipward-fleet-'));
  // Depth 1: a busy board. Depth 2: a quiet one. Plus a decoy without a
  // tracker and a repo whose tracker is broken.
  await mkdir(join(root, 'alpha', '.shipward'), { recursive: true });
  await writeFile(join(root, 'alpha', '.shipward', 'tracker.json'),
    trackerOf('alpha', 'Alpha', 'AL', [card('AL-001', 'alpha', 'claude'), card('AL-002', 'alpha', 'review'), card('AL-003', 'alpha', 'backlog')]));
  await mkdir(join(root, 'group', 'beta', '.shipward'), { recursive: true });
  await writeFile(join(root, 'group', 'beta', '.shipward', 'tracker.json'),
    trackerOf('beta', 'Beta', 'BE', []));
  await mkdir(join(root, 'decoy'));
  await mkdir(join(root, 'broken', '.shipward'), { recursive: true });
  await writeFile(join(root, 'broken', '.shipward', 'tracker.json'), 'not json at all');

  proc = spawn(process.execPath, [join(HERE, 'fleet.mjs'), root], {
    env: { ...process.env, SHIPWARD_FLEET_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`fleet never reported a port. stderr: ${err}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(t); res(Number(m[1])); }
    });
    proc.once('exit', (c) => { clearTimeout(t); rej(new Error(`fleet exited ${c}: ${err}`)); });
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  proc?.kill();
  await rm(root, { recursive: true, force: true });
});

// Child desks take a moment to report their ports; poll until they have.
async function fleetRows({ needDesks = true, tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const rows = await (await fetch(`${base}/api/fleet`)).json();
    if (!needDesks || rows.filter((r) => r.ok).every((r) => r.desk)) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('desks never came up');
}

test('discovers boards two levels deep, skips decoys, flags the unreadable', async () => {
  const rows = await fleetRows({ needDesks: false });
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Alpha', 'Beta', 'broken']);
  const brokenRow = rows.find((r) => !r.ok);
  assert.match(brokenRow.error, /unreadable/);
  assert.equal(brokenRow.desk, null, 'no desk for a board that cannot be read');
});

test('rows carry the counts and the last feed line, busiest board first', async () => {
  const rows = await fleetRows({ needDesks: false });
  assert.equal(rows[0].name, 'Alpha', 'two in flight sorts above zero');
  const alpha = rows[0];
  assert.equal(alpha.working, 1);
  assert.equal(alpha.review, 1);
  assert.equal(alpha.backlog, 1);
  assert.equal(alpha.last.msg, 'Alpha says hello');
  assert.equal(alpha.last.by, 'Claude Code');
});

test('each child desk serves ITS OWN board — isolation is the whole point', async () => {
  const rows = await fleetRows();
  for (const r of rows.filter((x) => x.ok)) {
    // The desk link now carries the way home; strip it for the API probe and
    // assert it points back at THIS fleet.
    const u = new URL(r.desk);
    assert.equal(u.pathname, '/', 'origin + fleet param only — the page validator counts on this shape');
    assert.equal(new URLSearchParams(u.search).get('fleet'), base.replace('127.0.0.1', 'localhost'), 'the return address names the fleet that spawned the desk');
    const doc = await (await fetch(`${u.origin.replace('localhost', '127.0.0.1')}/api/tracker`)).json();
    assert.equal(doc.projects[0].name, r.name, `${r.name}'s desk serves ${doc.projects[0].name}`);
  }
});

test('the index page is served and self-contained', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /the fleet/);
  assert.match(html, /\/api\/fleet/);
  // The comment in the page says "never innerHTML" — match the ASSIGNMENT,
  // not the vocabulary, or the rule's own documentation trips the test.
  assert.doesNotMatch(html, /\.innerHTML\s*=/, 'DOM building only — the desk rule (SW-025) holds here too');
  // And the page's script must PARSE — a template-literal escape slip once
  // shipped a real newline inside a JS string and killed the whole script,
  // which the poll's catch-all then hid completely.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script), 'the served page script is valid JavaScript');
});


/* ── onboarding over HTTP (SW-036) ───────────────────────── */

test('a git repo without a tracker is listed as a candidate, and the button onboards it', async () => {
  // gamma: a git repo the walk should offer to onboard.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const sh = promisify(execFile);
  await mkdir(join(root, 'gamma'));
  await sh('git', ['init', '-q'], { cwd: join(root, 'gamma') });

  let rows = await fleetRows({ needDesks: false });
  const cand = rows.find((r) => r.kind === 'candidate' && r.folder === 'gamma');
  assert.ok(cand, 'gamma is offered');

  const res = await fetch(`${base}/api/onboard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: cand.repo }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(root, 'gamma', '.shipward', 'tracker.json')), 'the tracker exists');
  assert.ok(existsSync(join(root, 'gamma', '.claude', 'settings.json')), 'the hooks exist');

  rows = await fleetRows({ needDesks: false });
  const board = rows.find((r) => r.kind === 'board' && r.folder === 'gamma');
  assert.ok(board?.ok, 'the candidate came back as a live board');
});

test('the endpoint refuses anything the walk did not offer', async () => {
  for (const repo of ['/etc', join(root, 'decoy'), null, join(root, 'alpha')]) {
    const res = await fetch(`${base}/api/onboard`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    assert.equal(res.status, 400, `${repo} must be refused`);
  }
});

// Runs LAST on purpose: it kills the fleet every other test talks to.
test('killing the fleet takes every desk down with it', async () => {
  const rows = await fleetRows();
  const pids = rows.map((r) => r.pid).filter(Boolean);
  assert.ok(pids.length >= 2, 'there are desks to take down');
  proc.kill();
  await new Promise((r) => setTimeout(r, 700));
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), `desk ${pid} must not outlive the fleet`);
  }
});
