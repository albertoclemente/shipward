// Shipward — zero-dependency server. Node built-ins only.
// Serves the static UI and brokers atomic reads/writes of the tracker file.
//   node shipward/serve.mjs  →  http://localhost:4747
import { createServer } from 'node:http';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const TRACKER = join(HERE, '..', '.shipward', 'tracker.json');
const PORT = 4747;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const send = (res, code, body, type = TYPES['.json']) => {
  if (res.writableEnded) return;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
};
const fail = (res, code, msg) => send(res, code, JSON.stringify({ error: msg }));

/* ── validation ──────────────────────────────────────────────
   The tracker is Claude Code's memory. A write that satisfies the
   server but not .shipward/schema.json poisons the next session, so
   validate the fields the schema marks required — not just the
   top-level container. */
const STATUS = new Set(['backlog', 'claude', 'review', 'pushed', 'shipped']);
const CLAUDE = new Set(['queued', 'working', 'done']);
const TYPE = new Set(['feature', 'bug', 'chore']);
const PRI = new Set(['P1', 'P2', 'P3']);
const EFFORT = new Set(['S', 'M', 'L']);
const ID_RE = /^[A-Z]+-[0-9]{3}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isTime = (v) => v == null || (isStr(v) && !Number.isNaN(Date.parse(v)));

function validate(d) {
  if (!isObj(d)) return 'not an object';
  if (d.version !== 1) return 'version must be 1';
  for (const k of ['projects', 'cards', 'feed']) if (!Array.isArray(d[k])) return `${k} must be an array`;

  for (const [i, p] of d.projects.entries()) {
    if (!isObj(p)) return `projects[${i}] is not an object`;
    for (const k of ['id', 'name', 'prefix']) if (!isStr(p[k])) return `projects[${i}].${k} must be a string`;
  }
  const seen = new Set();
  for (const [i, c] of d.cards.entries()) {
    if (!isObj(c)) return `cards[${i}] is not an object`;
    if (!isStr(c.id) || !ID_RE.test(c.id)) return `cards[${i}].id must match PREFIX-NNN`;
    if (seen.has(c.id)) return `duplicate card id ${c.id}`;
    seen.add(c.id);
    if (!isStr(c.p)) return `${c.id}.p must be a string`;
    if (!isStr(c.title)) return `${c.id}.title must be a string`;
    if (!TYPE.has(c.type)) return `${c.id}.type is invalid`;
    if (!PRI.has(c.pri)) return `${c.id}.pri is invalid`;
    if (!EFFORT.has(c.effort)) return `${c.id}.effort is invalid`;
    if (!STATUS.has(c.status)) return `${c.id}.status is invalid`;
    if (c.claude != null && !CLAUDE.has(c.claude)) return `${c.id}.claude is invalid`;
    if (!isStr(c.created) || Number.isNaN(Date.parse(c.created))) return `${c.id}.created must be a date-time`;
    if (!isTime(c.pushed)) return `${c.id}.pushed must be a date-time or null`;
    if (!isTime(c.shipped)) return `${c.id}.shipped must be a date-time or null`;
  }
  if (d.feed.length > 200) return 'feed exceeds the 200-entry cap';
  for (const [i, f] of d.feed.entries()) {
    if (!isObj(f)) return `feed[${i}] is not an object`;
    if (!isStr(f.t) || Number.isNaN(Date.parse(f.t))) return `feed[${i}].t must be a date-time`;
    if (!isStr(f.p)) return `feed[${i}].p must be a string`;
    if (!isStr(f.msg)) return `feed[${i}].msg must be a string`;
    if (f.by != null && f.by !== 'claude' && f.by !== 'user') return `feed[${i}].by is invalid`;
  }
  return null;
}

/* ── tracker io ──────────────────────────────────────────── */
async function readTracker(res) {
  let raw;
  try {
    raw = await readFile(TRACKER, 'utf8');
  } catch {
    return fail(res, 404, 'tracker.json not found at .shipward/tracker.json');
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return fail(res, 500, 'tracker.json is not valid JSON');
  }
  // Claude Code writes this file directly, so a GET can surface damage a PUT
  // never saw. Say so rather than handing the client something unrenderable.
  const bad = validate(doc);
  if (bad) return fail(res, 500, `tracker.json is not a valid tracker document: ${bad}`);
  send(res, 200, raw);
}

// Writes are serialized through this chain: two overlapping PUTs used to share
// one temp path and truncate each other before either rename.
let writeQueue = Promise.resolve();

async function atomicWrite(body) {
  const tmp = `${TRACKER}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, TRACKER);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function writeTracker(req, res) {
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch {
    return fail(res, 400, 'request body aborted');  // client closed the tab mid-write
  }
  let doc;
  try {
    doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return fail(res, 400, 'body is not valid JSON');
  }
  const bad = validate(doc);
  if (bad) return fail(res, 400, `body is not a valid tracker document: ${bad}`);

  const body = JSON.stringify(doc, null, 2) + '\n';
  const mine = writeQueue.then(() => atomicWrite(body), () => atomicWrite(body));
  writeQueue = mine.catch(() => {});
  try {
    await mine;
  } catch (err) {
    return fail(res, 500, `write failed: ${err.message}`);
  }
  send(res, 200, body);
}

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, 'malformed path encoding');   // e.g. GET /%
  }
  const file = resolve(join(PUBLIC, rel === '/' ? 'index.html' : rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return fail(res, 403, 'forbidden');
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    fail(res, 404, 'not found');
  }
}

// Every handler is async; an unhandled rejection here would take the whole desk
// down, so nothing escapes this wrapper.
createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return fail(res, 400, 'unparsable request path');
  }
  const done = (p) => p.catch((err) => fail(res, 500, `server error: ${err.message}`));

  if (pathname === '/api/tracker') {
    if (req.method === 'GET') return done(readTracker(res));
    if (req.method === 'PUT') return done(writeTracker(req, res));
    return fail(res, 405, 'use GET or PUT');
  }
  if (req.method !== 'GET') return fail(res, 405, 'use GET');
  done(serveStatic(pathname, res));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Shipward — the solo shipping desk\n  http://localhost:${PORT}\n  tracker: ${TRACKER}`);
});
