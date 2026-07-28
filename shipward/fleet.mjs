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
async function scan(dir = ROOT, depth = 0, out = []) {
  const tracker = join(dir, '.shipward', 'tracker.json');
  if (existsSync(tracker)) out.push({ repo: dir, tracker });
  if (depth >= SCAN_DEPTH) return out;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
    await scan(join(dir, e.name), depth + 1, out);
  }
  return out;
}

/* ── one child desk per tracker ──────────────────────────── */
// Keyed by tracker path. A child that dies stays dead until the fleet is
// restarted — a supervisor that flaps is worse than a row saying "desk down".
const desks = new Map();

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
async function rows() {
  const found = await scan();
  // A tracker that vanished takes its desk with it.
  for (const [tracker, entry] of desks) {
    if (!found.some((f) => f.tracker === tracker)) { entry.proc?.kill(); desks.delete(tracker); }
  }
  const out = [];
  for (const f of found.slice(0, MAX_DESKS)) {
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
        last: feed ? { msg: feed.msg, by: feed.by === 'user' ? 'You' : 'Claude Code', ago: relTime(feed.t) } : null,
        desk: desk.port ? `http://localhost:${desk.port}` : null,
        deskError: desk.error,
      });
    } catch (err) {
      out.push({ ...row, ok: false, name: row.folder, error: `tracker unreadable — ${err.message}`, desk: null });
    }
  }
  // The boards with something happening float to the top.
  return out.sort((a, b) => ((b.working ?? 0) + (b.review ?? 0)) - ((a.working ?? 0) + (a.review ?? 0))
    || String(a.name).localeCompare(String(b.name)));
}

/* ── the page ────────────────────────────────────────────── */
// Self-contained on purpose: the fleet must render even when every desk is
// down, so it shares no assets with them. Tokens mirror the desk's sheet.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipward — the fleet</title>
<style>
  :root { --bg:#f3f2f2; --surface:#eae9e9; --text:#201e1d; --accent:#ec3013; --muted:#605d5d;
          --divider:color-mix(in srgb,#201e1d 40%,transparent); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:400 15px/1.55 Archivo,system-ui,sans-serif; }
  header { display:flex; align-items:center; flex-wrap:wrap; gap:10px 24px;
           padding:12px 16px; border-bottom:2px solid var(--divider); }
  .mark { width:14px; height:14px; background:var(--accent); }
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
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style></head><body>
<header><div class="mark"></div><div class="brand">SHIPWARD</div><div class="tag">the fleet</div></header>
<main>
  <h3>Every board under __ROOT__</h3>
  <p class="lede" id="lede">Scanning…</p>
  <div id="rows" role="status"></div>
</main>
<script>
  // Built with DOM nodes, never innerHTML — the same rule the desk follows
  // (SW-025): a project name or feed message is tracker data, and tracker data
  // can arrive from anywhere. textContent cannot be mis-escaped.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  function rowNode(r) {
    const row = el('div', r.ok ? 'row' : 'row dead');
    if (r.ok && r.desk && /^http:\\/\\/localhost:\\d+$/.test(r.desk)) {
      const a = el('a', 'name', r.name);
      a.href = r.desk;
      row.append(a);
    } else {
      row.append(el('span', r.ok ? 'name dead' : 'name', r.name));
    }
    if (!r.ok) { row.append(el('span', 'down', r.error)); return row; }
    row.append(el('span', 'prefix', r.prefix + '-… · ' + r.folder));
    const stats = el('span', 'stats');
    stats.append(el('b', null, String(r.working)), ' working · ',
      el('b', null, String(r.review)), ' review · ',
      r.backlog + ' backlog · ' + r.pushed + ' pushed');
    row.append(stats);
    if (r.deskError) row.append(el('span', 'down', r.deskError));
    if (r.last) {
      const last = el('span', 'last');
      last.append(el('span', 'who', r.last.by), ' ' + r.last.msg + ' · ' + r.last.ago);
      row.append(last);
    }
    return row;
  }
  async function refresh() {
    try {
      const rows = await (await fetch('/api/fleet')).json();
      const active = rows.filter((r) => r.ok && (r.working + r.review) > 0).length;
      document.getElementById('lede').textContent =
        rows.length + ' board' + (rows.length === 1 ? '' : 's') + ' found' +
        (rows.length ? ' — ' + active + ' with something in flight. Click a name to open its desk.' : '.');
      const box = document.getElementById('rows');
      box.replaceChildren(...(rows.length ? rows.map(rowNode)
        : [el('p', 'lede', 'No .shipward/tracker.json under this root. Onboard a repo with shipward/setup.mjs.')]));
    } catch { /* the poll rides out a hiccup */ }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body></html>`;

/* ── server ──────────────────────────────────────────────── */
const log = (...a) => console.log(`fleet: ${a.join(' ')}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/fleet') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await rows()));
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
  console.log(`Shipward — the fleet\n  http://localhost:${port}\n  root: ${ROOT}`);
  // Spawn the desks up front so first click works; rows() keeps them honest.
  for (const f of (await scan()).slice(0, MAX_DESKS)) if (!desks.has(f.tracker)) spawnDesk(f);
});
