// Shipward — zero-dependency server. Node built-ins only.
// Serves the static UI and brokers reads/writes of the tracker file. All file
// access goes through tracker-store.mjs, which holds a cross-process lock so
// the MCP server and Claude Code can write the same file safely.
//   node shipward/serve.mjs  →  http://localhost:4747
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { readRaw, replace, TRACKER } from './tracker-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
// 0 asks the OS for a free port — how the tests avoid fighting over a fixed one.
// The bound port is printed on the line below, so a caller can read it back.
const PORT = Number(process.env.SHIPWARD_PORT ?? 4747);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const send = (res, code, body, type = TYPES['.json'], extra = {}) => {
  if (res.writableEnded) return;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }).end(body);
};
const fail = (res, code, msg, extra = {}) => send(res, code, JSON.stringify({ error: msg }), TYPES['.json'], extra);

// err.name, not instanceof: the store can legitimately be loaded under two
// specifiers (the test sandbox already does), and instanceof would then fail
// and turn a client's 400 into a 500.
const named = (err, name) => err?.name === name;

async function readTracker(res) {
  try {
    // The file's own bytes, not a re-serialization — a poll must not silently
    // reformat what Claude Code wrote. The ETag is what a later PUT must match.
    const { raw, etag } = await readRaw();
    send(res, 200, raw, TYPES['.json'], { etag });
  } catch (err) {
    if (named(err, 'MissingTrackerError')) return fail(res, 404, err.message);
    // Claude Code writes this file directly, so a GET can surface damage no
    // PUT ever saw. Say so rather than serving something unrenderable.
    if (named(err, 'ValidationError') || named(err, 'TrackerReadError')) return fail(res, 500, err.message);
    throw err;
  }
}

// Overlapping PUTs from one tab must land in arrival order. The file lock
// serializes across processes but its retry poll is unfair, so in-process
// ordering needs its own queue in front of it.
let putQueue = Promise.resolve();
const enqueue = (fn) => {
  const run = putQueue.then(fn, fn);
  putQueue = run.then(() => {}, () => {});
  return run;
};

// SW-044. The desk cannot run git — it is a page — so the one question it
// cannot answer for itself is answered here: how far has the tree moved since
// each piece of evidence was written.
//
// Read-only, and it fails soft. A repository that cannot be read returns an
// empty map, which renders as "unanchored" rather than as "current": the desk
// must never show a fresh badge because the server could not check.
async function readDrift(res) {
  try {
    const [{ driftSince }, { memoryEntries, anchors }, { doc }] = await Promise.all([
      import('./git.mjs'),
      import('./public/memory-lib.js'),
      readRaw(),
    ]);
    const entries = doc.projects.flatMap((p) => memoryEntries(doc.cards, p.id));
    return send(res, 200, JSON.stringify(await driftSince(anchors(entries))));
  } catch {
    return send(res, 200, '{}');
  }
}

async function writeTracker(req, res) {
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch {
    return fail(res, 400, 'request body aborted');   // client closed the tab mid-write
  }
  let doc;
  try {
    doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return fail(res, 400, 'body is not valid JSON');
  }
  // Optimistic concurrency. Without a precondition a client would be writing a
  // document built from an unlocked GET, which is how a desk write erased a
  // committed Claude write even with the lock working perfectly.
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    return fail(res, 428, 'If-Match required: GET /api/tracker first and send back its ETag');
  }
  try {
    const { body, etag } = await enqueue(() => replace(doc, ifMatch));
    send(res, 200, body, TYPES['.json'], { etag });
  } catch (err) {
    if (named(err, 'ValidationError')) return fail(res, 400, `body is not a valid tracker document: ${err.message}`);
    if (named(err, 'ConflictError')) {
      // Hand back what actually won so the client can re-apply its intent
      // rather than guess.
      return send(res, 409, JSON.stringify({ error: err.message, tracker: err.current.doc }),
        TYPES['.json'], { etag: err.current.etag });
    }
    return fail(res, 500, `write failed: ${err.message}`);
  }
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
const server = createServer((req, res) => {
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
  if (pathname === '/api/drift') {
    if (req.method !== 'GET') return fail(res, 405, 'use GET');
    return done(readDrift(res));
  }
  if (req.method !== 'GET') return fail(res, 405, 'use GET');
  done(serveStatic(pathname, res));
});

// A failed bind used to kill the process with no output, and a test harness
// waiting on the port then talked to whatever server already held it.
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Shipward: port ${PORT} is already in use — another desk is running.`
    : `Shipward: cannot listen on ${PORT} — ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`Shipward — the solo shipping desk\n  http://localhost:${port}\n  tracker: ${TRACKER}`);
});
