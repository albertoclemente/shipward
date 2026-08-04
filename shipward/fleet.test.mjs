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
    // { found, rows } since SW-046: `found` is what the walk saw, which can
    // exceed what the fleet shows, and the digest reports the difference.
    const { rows } = await (await fetch(`${base}/api/fleet`)).json();
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

test('the index page loads its script as a served module', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /the fleet/);
  // SW-047 moved the script out of the PAGE template into a real file. The
  // page no longer mentions /api/fleet because it no longer contains the
  // fetch — it names the module that does.
  assert.match(html, /<script type="module" src="\/fleet-client\.js">/);
  assert.doesNotMatch(html, /<script>/, 'no inline script left to mis-escape');
});

test('the served module is real JavaScript, and it is the thing that calls the API', async () => {
  // The old test compiled the inline script with new Function() to prove a
  // template-literal escape slip had not shipped a broken string (SW-036).
  // That hazard is gone with the literal; what replaces the check is that the
  // module is actually served, parses, and still reaches the endpoint.
  const res = await fetch(`${base}/fleet-client.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const src = await res.text();
  assert.match(src, /\/api\/fleet/, 'the poll moved here with the script');
  assert.doesNotMatch(src, /\.innerHTML\s*=/, 'DOM building only — the desk rule (SW-025) holds here too');
  assert.match(src, /from '\.\/fleet-view\.js'/, 'and the decisions live in the tested module');
});

test('the view module is served too, or the client cannot import it', async () => {
  const res = await fetch(`${base}/fleet-view.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /export function deskHref/);
});

test('the server hands out nothing but its two modules', async () => {
  // An allow-list, not a static directory: this server walks the user's whole
  // projects root.
  for (const path of ['/fleet.mjs', '/../fleet.mjs', '/public/lib.js', '/serve.mjs']) {
    const res = await fetch(`${base}${path}`);
    assert.notEqual(res.status, 200, `${path} must not be served`);
  }
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
/* ── SW-046: the fleet answers across boards ─────────────── */

test('the endpoint reports what the walk found, not only what it shows', async () => {
  const { found, rows } = await (await fetch(`${base}/api/fleet`)).json();
  assert.equal(typeof found, 'number');
  assert.ok(Array.isArray(rows));
  // With fewer boards than the desk cap these agree; the point is that `found`
  // exists at all, so a fleet past 16 boards can say what it left out instead
  // of dropping them silently.
  assert.equal(found, rows.filter((r) => r.kind === 'board').length);
});

test('each board carries the cards themselves, not just how many', async () => {
  const rows = await fleetRows();
  const board = rows.find((r) => r.kind === 'board' && r.ok);
  assert.ok(Array.isArray(board.inFlight), 'the cross-repo questions cannot be answered from counts');
  assert.ok(Array.isArray(board.waiting));
  assert.ok('lastShipped' in board);
  assert.equal(typeof board.everShipped, 'boolean');
});

test('the digest module is served, so the page can import it', async () => {
  const res = await fetch(`${base}/fleet-digest.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /export function digest/);
});

test('the favicon is served, and typed so a browser will actually use it', async () => {
  // An SVG served as text/javascript is silently ignored: the tab keeps its
  // blank default and nothing appears in the console to say why.
  const res = await fetch(`${base}/favicon.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /polygon/);
});

test('the page asks for the favicon and renders the mark inline', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  assert.match(html, /<svg class="mark"/, 'the mark is inline so it can use the token variables');
  assert.match(html, /var\(--accent\)/, 'and follows the token sheet rather than a frozen hex');
});


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
