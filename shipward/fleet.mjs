#!/usr/bin/env node
// The fleet — every onboarded board on one page.
//
//   node shipward/fleet.mjs ~/projects        → http://localhost:4740
//
// Scans the given root (two levels deep) for .shipward/tracker.json files and
// serves an index: one row per project — what is in flight, what waits, the
// last thing that happened — each linking into that repo's full desk.
//
// THE ARCHITECTURE IS THE POINT: this process never serves a board itself. It
// spawns one child desk per discovered tracker — the ordinary, already-proven
// serve.mjs, pinned to its repo with the same env belt the tests wear
// (SW-033's incident taught that lesson at full price) — and links to the port
// each child reports. Per-tracker etags, PUT routing, lock scope: all solved
// by not sharing a process, which is the same isolation the per-repo trackers
// were chosen for in the first place. The cost is one node process per board;
// for the solo shipper this page is for, that is nothing.
//
// Reads of tracker files here are lock-free and display-only, exactly like
// the desk's own GET: a torn read renders one stale row for three seconds.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveStats, latestFeed, relTime } from './public/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = join(HERE, 'serve.mjs');
const PUBLIC = join(HERE, 'public');

// The only files this server will hand out (SW-047). An allow-list, not a
// directory: the fleet walks the user's entire projects root, so a path-joining
// mistake in a generic static handler would serve anything on disk.
const SERVED = {
  '/fleet-client.js': 'fleet-client.js',
  '/fleet-view.js': 'fleet-view.js',
  '/fleet-digest.js': 'fleet-digest.js',
  '/favicon.svg': 'favicon.svg',
};

const ROOT = resolve(process.argv[2] || process.env.SHIPWARD_FLEET_ROOT || process.cwd());
const PORT = Number(process.env.SHIPWARD_FLEET_PORT ?? 4740);
const MAX_DESKS = 16;
const SCAN_DEPTH = 2;
const SKIP = new Set(['node_modules', '.git']);

if (!existsSync(ROOT)) {
  process.stderr.write(`shipward fleet: ${ROOT} does not exist\n`);
  process.exit(1);
}

/* ── discovery ───────────────────────────────────────────── */
// Two kinds of find: boards (a tracker exists) and CANDIDATES — git repos the
// walk saw that are not onboarded yet. Candidates become rows with an Onboard
// button, because "I do not want commands" is a legitimate requirement and the
// fleet already knows where the projects live.
async function scan(dir = ROOT, depth = 0, out = { boards: [], candidates: [] }) {
  const tracker = join(dir, '.shipward', 'tracker.json');
  if (existsSync(tracker)) out.boards.push({ repo: dir, tracker });
  else if (existsSync(join(dir, '.git'))) out.candidates.push({ repo: dir });
  if (depth >= SCAN_DEPTH) return out;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
    await scan(join(dir, e.name), depth + 1, out);
  }
  return out;
}

/* ── onboarding over HTTP ────────────────────────────────── */
// Runs the exact same setup.mjs the command line runs — one implementation of
// "wire a repo", per the one-module rule. The path is never taken on faith:
// the request must name a repo the walk itself just found as a candidate, so
// this endpoint cannot be aimed at an arbitrary directory.
const SETUP = join(HERE, 'setup.mjs');
const { execFile } = await import('node:child_process');

function onboard(repo) {
  return new Promise((res) => {
    execFile(process.execPath, [SETUP, repo], { timeout: 15000 }, (err, stdout, stderr) => {
      res({ ok: !err, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

/* ── one child desk per tracker ──────────────────────────── */
// Keyed by tracker path. A child that dies stays dead until the fleet is
// restarted — a supervisor that flaps is worse than a row saying "desk down".
const desks = new Map();
// Known once listen() lands; rows built before that omit the return address.
let fleetPort = null;

function spawnDesk({ repo, tracker }) {
  if (desks.size >= MAX_DESKS) return { port: null, error: `desk limit (${MAX_DESKS}) reached` };
  const entry = { proc: null, port: null, error: null };
  desks.set(tracker, entry);
  const proc = spawn(process.execPath, [SERVE], {
    cwd: repo,
    // The same belt the tests wear: explicit env, so no resolution-order
    // change can ever aim this desk at a different repo's board.
    env: { ...process.env, SHIPWARD_TRACKER: tracker, SHIPWARD_REPO: repo, SHIPWARD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.proc = proc;
  let out = '';
  proc.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/http:\/\/localhost:(\d+)/);
    if (m && !entry.port) {
      entry.port = Number(m[1]);
      log(`desk for ${basename(repo)} on :${entry.port}`);
    }
  });
  proc.once('exit', (code) => {
    if (desks.get(tracker) === entry) { entry.error = `desk exited (${code})`; entry.port = null; }
  });
  return entry;
}

function killDesks() {
  for (const { proc } of desks.values()) proc?.kill();
}
process.on('exit', killDesks);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { killDesks(); process.exit(0); });
}

/* ── rows ────────────────────────────────────────────────── */
// How many cards of one kind a single board may contribute (SW-046). The
// digest is read at a glance and travels over the wire on every poll; one repo
// with forty reviews must not crowd out the other nine boards entirely.
const FLEET_CARD_CAP = 10;

// When a card was last touched — the honest age of a review. `pushed` and
// `shipped` are stamps a review has not earned yet, so the newest note entry is
// usually the real answer, and `created` is the floor.
const lastTouched = (c) => {
  const stamps = [c.created, c.pushed, c.shipped]
    .concat(Array.isArray(c.note) ? c.note.map((e) => e?.t) : [])
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
};

const lastShippedAt = (cards) => {
  const stamps = cards
    .map((c) => Date.parse(c.shipped || c.pushed))
    .filter((t) => !Number.isNaN(t));
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
};

async function rows() {
  const found = await scan();
  // A tracker that vanished takes its desk with it.
  for (const [tracker, entry] of desks) {
    if (!found.boards.some((f) => f.tracker === tracker)) { entry.proc?.kill(); desks.delete(tracker); }
  }
  const out = [];
  for (const f of found.boards.slice(0, MAX_DESKS)) {
    const desk = desks.get(f.tracker) ?? spawnDesk(f);
    const row = { repo: f.repo, folder: basename(f.repo), pid: desk.proc?.pid ?? null };
    try {
      const doc = JSON.parse(await readFile(f.tracker, 'utf8'));
      const project = doc.projects.find((p) => p.id === doc.activeProject) || doc.projects[0] || {};
      const cards = doc.cards.filter((c) => c.p === project.id);
      const count = (s) => cards.filter((c) => c.status === s).length;
      const feed = latestFeed(doc.feed, project.id);
      out.push({
        ...row,
        ok: true,
        name: project.name || row.folder,
        prefix: project.prefix || '',
        working: count('claude'),
        review: count('review'),
        backlog: count('backlog'),
        pushed: count('pushed'),
        statLine: deriveStats(doc.cards, project.id).line,
        // SW-046. The cards themselves, not just how many — the cross-repo
        // questions cannot be answered from counts. Bounded per board so one
        // busy repo cannot dominate the payload.
        inFlight: cards.filter((c) => c.status === 'claude')
          .slice(0, FLEET_CARD_CAP)
          .map((c) => ({ id: c.id, title: c.title, claude: c.claude, branch: c.branch })),
        waiting: cards.filter((c) => c.status === 'review')
          .slice(0, FLEET_CARD_CAP)
          .map((c) => ({ id: c.id, title: c.title, since: lastTouched(c) })),
        lastShipped: lastShippedAt(cards),
        everShipped: cards.some((c) => c.pushed || c.shipped),
        last: feed ? { msg: feed.msg, by: feed.by === 'user' ? 'You' : 'Claude Code', ago: relTime(feed.t) } : null,
        // The return address rides along, so the desk can offer a way home —
        // a desk opened any other way shows nothing.
        desk: desk.port && fleetPort
          ? `http://localhost:${desk.port}/?fleet=${encodeURIComponent(`http://localhost:${fleetPort}`)}`
          : (desk.port ? `http://localhost:${desk.port}` : null),
        deskError: desk.error,
      });
    } catch (err) {
      out.push({ ...row, ok: false, name: row.folder, error: `tracker unreadable — ${err.message}`, desk: null });
    }
  }
  // The boards with something happening float to the top; candidates trail,
  // dimmed, waiting for their button to be pressed.
  out.sort((a, b) => ((b.working ?? 0) + (b.review ?? 0)) - ((a.working ?? 0) + (a.review ?? 0))
    || String(a.name).localeCompare(String(b.name)));
  const candidates = found.candidates
    .map((c) => ({ kind: 'candidate', repo: c.repo, folder: basename(c.repo), name: basename(c.repo) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // `found` travels with the rows so the digest can say what it did NOT see.
  // The desk cap used to drop boards past MAX_DESKS with no mention anywhere,
  // which reads as full coverage — and a cross-repo answer that silently omits
  // a repo is worse than no cross-repo answer.
  return {
    found: found.boards.length,
    rows: [...out.map((r) => ({ kind: 'board', ...r })), ...candidates],
  };
}

/* ── the page ────────────────────────────────────────────── */
// Self-contained on purpose: the fleet must render even when every desk is
// down, so it shares no assets with them. Tokens mirror the desk's sheet.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipward — the fleet</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { --bg:#f3f2f2; --surface:#eae9e9; --text:#201e1d; --accent:#ec3013; --muted:#605d5d;
          --divider:color-mix(in srgb,#201e1d 40%,transparent); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:400 15px/1.55 Archivo,system-ui,sans-serif; }
  header { display:flex; align-items:center; flex-wrap:wrap; gap:10px 24px;
           padding:12px 16px; border-bottom:2px solid var(--divider); }
  .mark { flex:none; display:block; }
  .brand { font-weight:800; font-size:18px; letter-spacing:.03em; }
  .tag { color:var(--muted); font-size:12px; }
  main { padding:24px 16px; max-width:1100px; }
  h3 { font-weight:800; font-size:25px; margin:0 0 4px; }
  .lede { color:var(--muted); font-size:13px; margin:0 0 24px; }
  .row { display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; padding:14px 16px;
         background:var(--surface); border:1px solid #d7d3d3; margin-bottom:12px; }
  .row a.name { font-weight:800; font-size:16px; color:var(--text); text-decoration:none; }
  .row a.name:hover { color:var(--accent); }
  .prefix { font:600 11px ui-monospace,Menlo,monospace; color:var(--muted); }
  .stats { font-weight:600; font-size:12px; font-variant-numeric:tabular-nums; }
  .stats b { color:var(--accent); }
  .last { flex-basis:100%; color:var(--muted); font-size:12px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .last .who { font-weight:600; color:var(--text); }
  .down { color:#ae1800; font-size:12px; }
  .dead { opacity:.6; }
  .cand { opacity:.75; border-style:dashed; }
  .onboard { font:800 12px Archivo,system-ui,sans-serif; letter-spacing:.02em; cursor:pointer;
             background:var(--accent); color:var(--bg); border:none; padding:7px 14px; min-height:32px; }
  .onboard:hover { background:#dd2b0f; }
  .onboard:disabled { opacity:.5; cursor:wait; }
  .cand .tagline { color:var(--muted); font-size:12px; }
  .digest { margin:0 0 28px; padding:16px; background:var(--surface); border-left:3px solid var(--accent); }
  .digest-lede { margin:0 0 12px; font-weight:600; font-size:13.5px; }
  .digest-group { margin-top:12px; }
  .digest-heading { margin:0 0 6px; font-size:11px; letter-spacing:.08em; text-transform:uppercase;
                    font-weight:800; color:var(--muted); }
  .digest-item { display:flex; gap:10px; align-items:baseline; font-size:13px; padding:2px 0;
                 font-variant-numeric:tabular-nums; }
  .digest-board { flex:none; min-width:150px; font-weight:600; color:var(--text); text-decoration:none; }
  a.digest-board:hover { color:var(--accent); }
  .digest-text { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style></head><body>
<header><svg class="mark" width="16" height="16" viewBox="0 0 32 32" aria-hidden="true"><polygon points="2,20 30,20 23,29 9,29" fill="var(--text)"></polygon><polygon points="16,4 9,18 23,18" fill="var(--accent)"></polygon></svg><div class="brand">SHIPWARD</div><div class="tag">the fleet</div></header>
<main>
  <h3>Every board under __ROOT__</h3>
  <p class="lede" id="lede">Scanning…</p>
  <div id="digest"></div>
  <div id="rows" role="status"></div>
</main>
<script type="module" src="/fleet-client.js"></script>
</body></html>`;

/* ── server ──────────────────────────────────────────────── */
const log = (...a) => console.log(`fleet: ${a.join(' ')}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // SW-047. The page's script is a real module now, so it has to be served.
    // Confined to an allow-list rather than a static directory: this server
    // walks the user's whole projects root, and a path-joining bug here would
    // hand any file on disk to a browser.
    if (SERVED[url.pathname]) {
      // Typed by extension since SW-061 added the favicon: an SVG served as
      // text/javascript is ignored by every browser, and the tab would keep
      // its blank default icon with nothing in the console to explain why.
      const type = url.pathname.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(await readFile(join(PUBLIC, SERVED[url.pathname]), 'utf8'));
    } else if (url.pathname === '/api/fleet') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await rows()));
    } else if (url.pathname === '/api/onboard' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      await new Promise((r) => req.on('end', r));
      let repo;
      try { repo = JSON.parse(body).repo; } catch { /* falls through to the check */ }
      // Only a repo the walk itself just found as a candidate. Anything else —
      // an arbitrary path, an already-onboarded board, a dir with no git —
      // is refused with the reason.
      const { candidates } = await scan();
      const hit = candidates.find((c) => c.repo === repo);
      if (!hit) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not an onboardable repo under this root (needs .git, no tracker yet)' }));
        return;
      }
      const result = await onboard(hit.repo);
      log(`onboard ${basename(hit.repo)}: ${result.ok ? 'ok' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE.replace('__ROOT__', ROOT.replace(/[&<>]/g, '')));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.on('error', (err) => {
  process.stderr.write(err.code === 'EADDRINUSE'
    ? `fleet: port ${PORT} is already in use — another fleet is running.\n`
    : `fleet: cannot listen on ${PORT} — ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  const port = server.address().port;
  fleetPort = port;
  console.log(`Shipward — the fleet\n  http://localhost:${port}\n  root: ${ROOT}`);
  // Spawn the desks up front so first click works; rows() keeps them honest.
  for (const f of (await scan()).boards.slice(0, MAX_DESKS)) if (!desks.has(f.tracker)) spawnDesk(f);
});
