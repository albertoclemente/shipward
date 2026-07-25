// Shipward — zero-dependency server. Node built-ins only.
// Serves the static UI and brokers reads/writes of the tracker file. All file
// access goes through tracker-store.mjs, which holds a cross-process lock so
// the MCP server and Claude Code can write the same file safely.
//   node shipward/serve.mjs  →  http://localhost:4747
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { read, replace, serialize, TRACKER, ValidationError, MissingTrackerError } from './tracker-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
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

async function readTracker(res) {
  try {
    send(res, 200, serialize(await read()));
  } catch (err) {
    if (err instanceof MissingTrackerError) return fail(res, 404, err.message);
    // Claude Code writes this file directly, so a GET can surface damage no
    // PUT ever saw. Say so rather than serving something unrenderable.
    if (err instanceof ValidationError) return fail(res, 500, err.message);
    throw err;
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
  try {
    send(res, 200, await replace(doc));
  } catch (err) {
    if (err instanceof ValidationError) return fail(res, 400, `body is not a valid tracker document: ${err.message}`);
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
