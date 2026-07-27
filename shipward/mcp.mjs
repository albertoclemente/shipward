#!/usr/bin/env node
// Shipward MCP server — the tracker as a tool surface for Claude Code.
//
// Zero dependencies, by constraint: the protocol is newline-delimited JSON-RPC
// 2.0 over stdio, which is small enough to hand-roll and leaves nothing to
// install or keep current. stdout carries protocol frames ONLY — every log line
// goes to stderr, because one stray console.log corrupts the stream.
//
// The five tools mirror the five slash commands in .claude/commands. Each does
// the tracker half of its command; git, and the work itself, stay with Claude.
// Every rule they apply — id allocation, branch naming, status transitions,
// feed copy — is imported from public/lib.js, the same module the board runs,
// so the desk and Claude cannot drift apart.
//
// Writes go through tracker-store.mjs, which holds a cross-process lock. The
// desk, this server and a direct file edit can all be writing at once.
import { readRaw, mutate, TRACKER } from './tracker-store.mjs';
import {
  nextId, autoBranch, applyTransition, feedAdd, moveMsg, addMsg, cardsOf, fmtDate,
} from './public/lib.js';

const NAME = 'shipward';
const VERSION = '1.0.0';
const PROTOCOL = '2025-11-25';
// Older clients get the version they asked for; the wire shape we implement is
// identical across these. Anything else is answered with ours.
const ALSO_SPOKEN = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const log = (...a) => process.stderr.write(`shipward-mcp: ${a.join(' ')}\n`);
const nowIso = () => new Date().toISOString();

// The desk's "MCP CONNECTED" tag reads doc.mcp.lastSeen and goes dark after
// MCP_STALE_MS (150s), so a tag that is lit means a server really is listening.
// The interval is well inside that window: one slow write must not flicker it.
//
// KNOWN TRADEOFF, chosen deliberately: the heartbeat lives in tracker.json, so
// a committed tracker goes dirty in git about once a minute while a session is
// open. The alternative was a .shipward/mcp-status.json sidecar, which keeps
// git quiet at the cost of a second file to keep in sync and a second thing to
// explain. One file that is occasionally dirty beat two files that can disagree.
const HEARTBEAT_MS = 60000;

async function beat() {
  try {
    await mutate((doc) => ({ ...doc, mcp: { lastSeen: nowIso(), pid: process.pid } }));
  } catch (err) {
    // A heartbeat is never worth failing a session over — not a missing
    // tracker, not a lock we could not get.
    log(`heartbeat skipped: ${err.message}`);
  }
}

/* ── tracker helpers ─────────────────────────────────────── */
const projectOf = (doc, wanted) => {
  if (wanted) {
    const p = doc.projects.find((x) => x.id === wanted || x.name === wanted);
    if (!p) throw new ToolError(`no project "${wanted}" — have: ${doc.projects.map((x) => x.id).join(', ')}`);
    return p;
  }
  return doc.projects.find((p) => p.id === doc.activeProject) || doc.projects[0];
};

// A tool failure the caller can act on, as opposed to a bug in this server.
class ToolError extends Error {
  constructor(msg) { super(msg); this.name = 'ToolError'; }
}

const findCard = (doc, id) => {
  const card = doc.cards.find((c) => c.id === id);
  if (card) return card;
  // Unknown id: say what is actually startable rather than just "not found".
  const near = doc.cards
    .filter((c) => c.status === 'backlog')
    .slice(0, 5)
    .map((c) => `${c.id} — ${c.title}`);
  throw new ToolError(
    near.length
      ? `no card ${id}. Closest backlog cards:\n${near.map((l) => `  ${l}`).join('\n')}`
      : `no card ${id}, and the backlog is empty.`,
  );
};

const PRI_ORDER = { P1: 0, P2: 1, P3: 2 };
const byPriThenAge = (a, b) =>
  (PRI_ORDER[a.pri] ?? 9) - (PRI_ORDER[b.pri] ?? 9) || Date.parse(a.created) - Date.parse(b.created);

/* ── tools ───────────────────────────────────────────────── */
const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'standup',
    title: 'Standup',
    description:
      'Read the tracker and report the state of the active project: what Claude is working on, what is waiting for review, the top of the backlog, and what shipped in the last week. Read-only — call this at the start of a session before doing anything else.',
    inputSchema: {
      type: 'object',
      properties: { project: str('Project id or name. Defaults to the active project.') },
      additionalProperties: false,
    },
    run: standup,
  },
  {
    name: 'log',
    title: 'Log a card',
    description:
      'Add a card to the backlog. Use this the moment work is discovered or promised — a bug seen in passing, a follow-up, a TODO — so that nothing lives only in the conversation. Infer type, priority and effort from the description yourself and pass them; put the context a future session would need in `note`.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line: what is being built or fixed.'),
        type: { type: 'string', enum: ['feature', 'bug', 'chore'], description: 'Defaults to feature.' },
        pri: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Defaults to P2.' },
        effort: { type: 'string', enum: ['S', 'M', 'L'], description: 'Defaults to M.' },
        note: str('Context for whoever picks this up — including a later you.'),
        project: str('Project id or name. Defaults to the active project.'),
      },
      required: ['title'],
      additionalProperties: false,
    },
    run: logCard,
  },
  {
    name: 'start',
    title: 'Start a card',
    description:
      'Take a card: status becomes claude/working and a branch is named if it has none. Returns the branch to check out and the card note. Call this BEFORE writing any code — work that is not on a card is work the next session cannot see.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Card id, e.g. SW-005.'),
        branch: str('Override the branch name. Omit to derive it from the card type and title.'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: startCard,
  },
  {
    name: 'done',
    title: 'Finish a card',
    description:
      'Hand a card back: status becomes review (or pushed, if it is already deployed), claude becomes done, and `note` gains what changed and why. Append the decisions and gotchas — that note is the memory a future session reads.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Card id.'),
        commit: str('Short sha of the latest commit.'),
        note: str('What changed, decisions taken, anything that bit you. Appended to the existing note.'),
        pushed: { type: 'boolean', description: 'True if this is already deployed; sets status pushed and stamps the timestamp.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: doneCard,
  },
  {
    name: 'sync',
    title: 'Sync with reality',
    description:
      'Reconcile the tracker with git in one atomic write: apply status/commit corrections, add cards for work that exists in git but not on the board, and record a single feed entry describing the audit. Work out the truth from git yourself, then pass the fixes here.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: str('One line describing what the audit found. Recorded in the feed.'),
        updates: {
          type: 'array',
          description: 'Corrections to existing cards.',
          items: {
            type: 'object',
            properties: {
              id: str('Card id.'),
              status: { type: 'string', enum: ['backlog', 'claude', 'review', 'pushed', 'shipped'] },
              commit: str('Short sha.'),
              branch: str('Branch name.'),
              note: str('Appended to the card note.'),
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        create: {
          type: 'array',
          description: 'Cards for work visible in git but missing from the board.',
          items: {
            type: 'object',
            properties: {
              title: str('One line.'),
              type: { type: 'string', enum: ['feature', 'bug', 'chore'] },
              pri: { type: 'string', enum: ['P1', 'P2', 'P3'] },
              effort: { type: 'string', enum: ['S', 'M', 'L'] },
              status: { type: 'string', enum: ['backlog', 'claude', 'review', 'pushed', 'shipped'] },
              branch: str('Branch name.'),
              commit: str('Short sha.'),
              note: str('Context.'),
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
        project: str('Project id or name. Defaults to the active project.'),
      },
      required: ['summary'],
      additionalProperties: false,
    },
    run: syncCards,
  },
];

async function standup({ project: wanted }) {
  const { doc } = await readRaw();
  const project = projectOf(doc, wanted);
  const mine = cardsOf(doc.cards, project.id);
  const of = (s) => mine.filter((c) => c.status === s);

  const lines = [`${project.name} (${project.prefix}) — ${mine.length} cards`];

  const working = of('claude');
  lines.push(`Claude working (${working.length})`);
  for (const c of working) {
    lines.push(`  ${c.id} ${c.claude || 'queued'}${c.branch ? ` · ${c.branch}` : ''} — ${c.title}`);
  }

  const review = of('review');
  lines.push(`Waiting on you (${review.length})`);
  for (const c of review.slice(0, 5)) lines.push(`  ${c.id} — ${c.title}`);
  if (review.length > 5) lines.push(`  …and ${review.length - 5} more`);

  const backlog = of('backlog').slice().sort(byPriThenAge);
  lines.push(`Backlog (${backlog.length})${backlog.length > 3 ? ' — top 3 by priority, then age' : ''}`);
  for (const c of backlog.slice(0, 3)) lines.push(`  ${c.id} ${c.pri}/${c.effort} — ${c.title}`);

  // "Shipped" here means it reached production, whether or not it has since
  // been filed to the archive.
  const weekAgo = Date.now() - 7 * 86400_000;
  const recent = mine.filter((c) => {
    const t = Date.parse(c.shipped || c.pushed);
    return !Number.isNaN(t) && t >= weekAgo;
  });
  lines.push(`Shipped in the last 7 days (${recent.length})`);
  for (const c of recent) lines.push(`  ${c.id} ${fmtDate(c.shipped || c.pushed)} — ${c.title}`);

  return lines.join('\n');
}

async function logCard({ title, type = 'feature', pri = 'P2', effort = 'M', note, project: wanted }) {
  if (!String(title || '').trim()) throw new ToolError('a card needs a title');
  let created;
  await mutate((doc) => {
    const project = projectOf(doc, wanted);
    const id = nextId(doc.cards, project.prefix);
    created = { id, project };
    doc.cards.unshift({
      id, p: project.id, title: String(title).trim(), type, pri, effort,
      status: 'backlog', claude: null, branch: null, commit: null,
      note: note || '', created: nowIso(), pushed: null, shipped: null,
    });
    doc.feed = feedAdd(doc.feed, project.id, addMsg(id), nowIso(), 'claude');
    return doc;
  });
  return `${created.id} added to ${created.project.name} backlog — ${title}`;
}

async function startCard({ id, branch }) {
  let out;
  await mutate((doc) => {
    const card = findCard(doc, id);
    if (card.status === 'claude' && card.claude === 'working') {
      // Idempotent: re-running /start after a crash should re-report the
      // context, not refuse.
      out = { card, already: true };
      return null;
    }
    // applyTransition is the same function the board's drag uses, so a card
    // started here and one dragged there end up in the same shape.
    const moved = applyTransition(card, 'claude', nowIso()) || { ...card };
    moved.claude = 'working';                       // the board queues; we are on it now
    if (branch) moved.branch = branch;
    if (!moved.branch) moved.branch = autoBranch(moved);
    doc.cards[doc.cards.indexOf(card)] = moved;
    doc.feed = feedAdd(doc.feed, moved.p, moveMsg(id, 'claude'), nowIso(), 'claude');
    out = { card: moved, already: false };
    return doc;
  });

  const { card, already } = out;
  const lines = [
    already
      ? `${card.id} was already in progress on ${card.branch}.`
      : `${card.id} is yours — status claude/working on ${card.branch}.`,
    `Title: ${card.title}`,
    `Type ${card.type} · ${card.pri} · effort ${card.effort}`,
  ];
  lines.push(card.note ? `Note:\n${card.note}` : 'Note: (empty)');
  lines.push(`Next: git checkout -b ${card.branch}`);
  return lines.join('\n');
}

async function doneCard({ id, commit, note, pushed = false }) {
  const to = pushed ? 'pushed' : 'review';
  let card;
  await mutate((doc) => {
    const found = findCard(doc, id);
    const moved = applyTransition(found, to, nowIso()) || { ...found };
    moved.claude = 'done';
    if (commit) moved.commit = commit;
    if (note) moved.note = moved.note ? `${moved.note} || ${note}` : note;
    doc.cards[doc.cards.indexOf(found)] = moved;
    doc.feed = feedAdd(doc.feed, moved.p, moveMsg(id, to), nowIso(), 'claude');
    card = moved;
    return doc;
  });
  return [
    `${card.id} → ${to}${card.commit ? ` at ${card.commit}` : ''}.`,
    `Title: ${card.title}`,
    to === 'review'
      ? 'It is on the Review column now; only the human moves it to Pushed.'
      : `Stamped pushed ${fmtDate(card.pushed)}.`,
  ].join('\n');
}

async function syncCards({ summary, updates = [], create = [], project: wanted }) {
  if (!String(summary || '').trim()) throw new ToolError('sync needs a one-line summary for the feed');
  const changed = [];
  const added = [];
  await mutate((doc) => {
    const project = projectOf(doc, wanted);
    for (const u of updates) {
      const card = findCard(doc, u.id);
      let next = card;
      if (u.status && u.status !== card.status) {
        next = applyTransition(card, u.status, nowIso()) || card;
      } else {
        next = { ...card };
      }
      if (u.commit) next.commit = u.commit;
      if (u.branch) next.branch = u.branch;
      if (u.note) next.note = next.note ? `${next.note} || ${u.note}` : u.note;
      doc.cards[doc.cards.indexOf(card)] = next;
      changed.push(`${next.id} → ${next.status}${u.commit ? ` @${u.commit}` : ''}`);
    }
    for (const c of create) {
      const id = nextId(doc.cards, project.prefix);
      doc.cards.unshift({
        id, p: project.id, title: String(c.title).trim(),
        type: c.type || 'chore', pri: c.pri || 'P2', effort: c.effort || 'M',
        status: c.status || 'backlog', claude: null,
        branch: c.branch || null, commit: c.commit || null,
        note: c.note || '', created: nowIso(),
        pushed: c.status === 'pushed' ? nowIso() : null,
        shipped: c.status === 'shipped' ? nowIso() : null,
      });
      added.push(`${id} ${c.title}`);
    }
    // One feed entry for the whole audit, per the /sync contract — not one per
    // card, which would bury a week of real activity under bookkeeping.
    doc.feed = feedAdd(doc.feed, project.id, `Synced with git — ${summary}`, nowIso(), 'claude');
    return doc;
  });
  const lines = [`Sync applied: ${changed.length} updated, ${added.length} created.`];
  for (const l of changed) lines.push(`  ${l}`);
  for (const l of added) lines.push(`  + ${l}`);
  return lines.join('\n');
}

/* ── JSON-RPC ────────────────────────────────────────────── */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], isError });

async function callTool(params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    // A wrong tool name is the model's mistake to correct, not a protocol
    // failure, so it comes back as an errored result it can read and retry.
    return text(`no tool "${params?.name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`, true);
  }
  try {
    return text(await tool.run(params.arguments || {}));
  } catch (err) {
    if (err.name === 'ToolError' || err.name === 'ValidationError' || err.name === 'ConflictError') {
      return text(err.message, true);
    }
    if (err.name === 'MissingTrackerError') {
      return text(`${err.message}\nShipward has not been set up in this repo yet.`, true);
    }
    log(`${tool.name} failed: ${err.stack || err.message}`);
    return text(`${tool.name} failed: ${err.message}`, true);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return result(id, {
        protocolVersion: asked === PROTOCOL || ALSO_SPOKEN.has(asked) ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, title: 'Shipward', version: VERSION },
        instructions:
          `The Shipward tracker at ${TRACKER} is your memory for this repo, not a status board you update afterwards. `
          + 'Call standup at the start of a session. Every piece of work needs a card before it is begun (log, then start), '
          + 'and every finished piece needs done with a note a future session can read. Never delete a card — archive it.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;                                   // notifications get no reply, ever
    case 'ping':
      return isNotification ? undefined : result(id, {});
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
      });
    case 'tools/call':
      return result(id, await callTool(params));
    default:
      if (isNotification) return;               // unknown notification: ignore
      return error(id, -32601, `method not found: ${method}`);
  }
}

/* ── stdio transport ─────────────────────────────────────── */
// Newline-delimited JSON. A chunk can hold several messages or half of one, so
// the tail is always carried over rather than parsed.
let buffer = '';
// Sequential: two tool calls in flight would each take the tracker lock, and
// the second would sit waiting on the first for no benefit.
let queue = Promise.resolve();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      error(null, -32700, 'parse error: each line must be one JSON-RPC message');
      continue;
    }
    if (Array.isArray(msg)) {
      error(null, -32600, 'batch requests are not supported; send one message per line');
      continue;
    }
    queue = queue.then(() => handle(msg)).catch((err) => {
      log(`handler crashed: ${err.stack || err.message}`);
      if (msg?.id != null) error(msg.id, -32603, `internal error: ${err.message}`);
    });
  }
});

// Drain before exiting. Exiting the moment stdin closed killed whatever call
// was still running — including one holding the tracker lock mid-write, which
// loses the write and never answers. No further input can arrive, so the queue
// as it stands now is the whole remaining job.
// Drain before exiting. Exiting the moment stdin closed killed whatever call
// was still running — including one holding the tracker lock mid-write, which
// loses the write and never answers. No further input can arrive, so the queue
// as it stands now is the whole remaining job.
process.stdin.on('end', () => {
  queue.then(() => process.exit(0), () => process.exit(0));
});
// The client going away mid-write is a normal shutdown, not a crash.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') log(`stdout: ${err.message}`); });
process.on('uncaughtException', (err) => { log(`uncaught: ${err.stack}`); });

// Beat once at startup so the tag lights as soon as Claude Code connects,
// rather than up to a minute later. unref so the heartbeat alone never holds
// the process open.
queue = queue.then(beat);
const heart = setInterval(() => { queue = queue.then(beat); }, HEARTBEAT_MS);
heart.unref?.();

log(`ready — ${TOOLS.length} tools, tracker ${TRACKER}`);
