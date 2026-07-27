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
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRaw, mutate, TRACKER } from './tracker-store.mjs';
import {
  nextId, autoBranch, applyTransition, feedAdd, moveMsg, addMsg, fmtDate,
} from './public/lib.js';
import { memoryEntries, recall as recallEntries, ALL_KINDS } from './public/memory-lib.js';
import { standupText, line } from './standup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// Nothing validates tool arguments against their own inputSchema, so anything
// that reaches the tracker is checked here. A non-string note used to be
// written verbatim and permanently brick the memory surface.
const asText = (v, field) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new ToolError(`${field} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}`);
  return v;
};

// nextId pads to three digits and the schema requires exactly three, so the
// thousandth card of a prefix used to fail with an opaque schema error and no
// way forward — renumbering is forbidden by the writing rules.
const freshId = (doc, project) => {
  const id = nextId(doc.cards, project.prefix);
  if (!/^[A-Z]+-[0-9]{3}$/.test(id)) {
    throw new ToolError(`the ${project.prefix} prefix is full at 999 cards — add a new project rather than renumbering`);
  }
  return id;
};

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
    name: 'recall',
    title: 'Recall what is known',
    description:
      'Search everything Claude Code has previously written down about this repo — decisions, reproduced bugs, gotchas, tradeoffs, open questions. Call this BEFORE editing an unfamiliar file: a finding is filed under the card that found it, not under the code it concerns, so the warning you need is never on the card you are working. Read-only. Every result carries the card and date it came from; judge it, do not simply believe it.',
    inputSchema: {
      type: 'object',
      properties: {
        file: str('A filename, with or without path or extension — e.g. "tracker-store.mjs" or "tracker-store". Returns what is known about it.'),
        kind: {
          type: 'string',
          enum: ['open', 'finding', 'decision', 'evidence', 'outcome', 'brief'],
          description: 'open = unresolved; finding = bugs and gotchas; decision = choices not to reverse; evidence = past verification, perishable.',
        },
        query: str('Free text matched against the notes, card ids and titles.'),
        limit: { type: 'number', description: 'Max entries, default 10, capped at 50.' },
        project: str('Project id or name. Defaults to the active project.'),
      },
      additionalProperties: false,
    },
    run: recall,
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
  return standupText(doc, projectOf(doc, wanted));
}

// The bridge between "the file I am about to edit" and "what the notes call
// it". SW-010's note — the most valuable one in this repo — names no file at
// all; it names isStale(), breakLock(), sweepTmp(), because that is how you
// write down what went wrong. So a file query reads the file and asks about
// everything declared inside it too.
const DECLARES = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
const SEARCH_DIRS = ['shipward', 'shipward/public', '.'];

async function tokensFor(file) {
  const want = file.trim().toLowerCase().split('/').pop();
  for (const dir of SEARCH_DIRS) {
    let names;
    try { names = await readdir(join(ROOT, dir)); } catch { continue; }
    const hit = names.find((n) => n.toLowerCase() === want)
      || names.find((n) => n.toLowerCase().startsWith(`${want}.`))
      || names.find((n) => n.toLowerCase().includes(want) && /\.(mjs|js|css|json|md|html)$/.test(n));
    if (!hit) continue;
    try {
      const src = await readFile(join(ROOT, dir, hit), 'utf8');
      const declared = new Set();
      for (const [, a, b] of src.matchAll(DECLARES)) declared.add(a || b);
      return { resolved: `${dir === '.' ? '' : `${dir}/`}${hit}`, tokens: [want, hit, ...declared] };
    } catch { /* unreadable — fall through to name-only */ }
  }
  return { resolved: null, tokens: [want] };
}

async function recall({ file, kind, query, limit = 10, project: wanted }) {
  if (!file && !kind && !query) {
    throw new ToolError('recall needs something to go on: a file, a kind (open|finding|decision|evidence|outcome|brief), or a query');
  }
  if (kind && !ALL_KINDS.some((k) => k.key === kind)) {
    throw new ToolError(`no kind "${kind}" — have: ${ALL_KINDS.map((k) => k.key).join(', ')}`);
  }
  const { doc } = await readRaw();
  const project = projectOf(doc, wanted);
  const all = memoryEntries(doc.cards, project.id);
  const bridge = file ? await tokensFor(file) : { resolved: null, tokens: null };
  // Math.min(50, NaN) is NaN, which used to survive this clamp and make recall
  // print a total and then list nothing at all.
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(50, limit) : 10;
  const hit = recallEntries(all, { file, kind, query, tokens: bridge.tokens, limit: take });

  const asked = [
    file && `file ${file}${bridge.resolved ? ` (${bridge.resolved}, plus the ${bridge.tokens.length - 2} names it declares)` : ' (not found on disk — matching on the name only)'}`,
    kind && `kind ${kind}`,
    query && `"${query}"`,
  ].filter(Boolean).join(', ');

  if (!hit.total) {
    // Say which haystack was searched. "Nothing" reads as "nothing happened
    // here" when it may only mean the note names the code differently.
    return `Nothing recalled for ${asked}. ${all.length} entries searched`
      + (file ? '; notes name code however they like, so try recall({query:"…"}) with a concept.' : '.');
  }

  const lines = [`${hit.total} recalled for ${asked}${hit.dropped ? `, showing ${hit.entries.length}` : ''}:`, ''];
  for (const e of hit.entries) {
    lines.push(line(e));
    if (e.refs.length) lines.push(`     files: ${e.refs.join(', ')}`);
    lines.push('');
  }
  if (hit.dropped) lines.push(`…${hit.dropped} more not shown — raise limit to see them.`);
  return lines.join('\n').trimEnd();
}

async function logCard({ title, type = 'feature', pri = 'P2', effort = 'M', note, project: wanted }) {
  const text = asText(title, 'title').trim();
  const context = asText(note, 'note');
  if (!text) throw new ToolError('a card needs a title');
  let created;
  await mutate((doc) => {
    const project = projectOf(doc, wanted);
    const id = freshId(doc, project);
    created = { id, project };
    doc.cards.unshift({
      id, p: project.id, title: text, type, pri, effort,
      status: 'backlog', claude: null, branch: null, commit: null,
      note: context, created: nowIso(), pushed: null, shipped: null,
    });
    doc.feed = feedAdd(doc.feed, project.id, addMsg(id), nowIso(), 'claude');
    return doc;
  });
  return `${created.id} added to ${created.project.name} backlog — ${text}`;
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
  lines.push(already ? `Next: git checkout ${card.branch}` : `Next: git checkout -b ${card.branch}`);
  return lines.join('\n');
}

async function doneCard({ id, commit, note, pushed = false }) {
  const to = pushed ? 'pushed' : 'review';
  const addition = asText(note, 'note');
  const sha = asText(commit, 'commit').trim();
  let card;
  await mutate((doc) => {
    const found = findCard(doc, id);
    const moved = applyTransition(found, to, nowIso()) || { ...found };
    moved.claude = 'done';
    // applyTransition returns null when the card is already in that status, so
    // done({pushed:true}) on an already-pushed card left `pushed` null while the
    // reply claimed a stamp — and the card then never counted as shipped.
    if (to === 'pushed' && !moved.pushed) moved.pushed = nowIso();
    if (sha) moved.commit = sha;
    if (addition) moved.note = moved.note ? `${moved.note} || ${addition}` : addition;
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
  const headline = asText(summary, 'summary').trim();
  if (!headline) throw new ToolError('sync needs a one-line summary for the feed');
  for (const [i, c] of create.entries()) {
    // logCard refuses an empty title; sync used to accept one and write a
    // permanent, undeletable card called "undefined" or "".
    if (!asText(c?.title, `create[${i}].title`).trim()) {
      throw new ToolError(`create[${i}] needs a title — sync will not add a nameless card`);
    }
    asText(c?.note, `create[${i}].note`);
  }
  for (const [i, u] of updates.entries()) asText(u?.note, `updates[${i}].note`);

  const changed = [];
  const added = [];
  const touched = new Set();
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
      touched.add(next.p);
      changed.push(`${next.id} → ${next.status}${u.commit ? ` @${u.commit}` : ''}`);
    }
    for (const c of create) {
      const id = freshId(doc, project);
      touched.add(project.id);
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
    // card, which would bury a week of real activity under bookkeeping. It is
    // filed against the project whose cards actually moved: findCard searches
    // every project, so an audit of one board used to be recorded on another.
    const home = touched.size === 1 ? [...touched][0] : project.id;
    doc.feed = feedAdd(doc.feed, home, `Synced with git — ${headline}`, nowIso(), 'claude');
    return doc;
  });
  const lines = [`Sync applied: ${changed.length} updated, ${added.length} created.`];
  for (const l of changed) lines.push(`  ${l}`);
  for (const l of added) lines.push(`  + ${l}`);
  return lines.join('\n');
}

/* ── JSON-RPC ────────────────────────────────────────────── */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
// Inside a batch the frames are collected and emitted together instead.
const emit = (collect, frame) => (collect ? collect(frame) : send(frame));
const result = (id, value, collect) => emit(collect, { jsonrpc: '2.0', id, result: value });
const error = (id, code, message, collect) => emit(collect, { jsonrpc: '2.0', id, error: { code, message } });

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

// Each member is dispatched as usual, but the replies leave as one array — a
// batch gets a batch back, and a batch of pure notifications gets nothing.
function handleBatch(batch) {
  const replies = [];
  const collect = (frame) => { replies.push(frame); };
  Promise.all(batch.map((m) => (isObj(m)
    ? Promise.resolve(handle(m, collect)).catch((err) => {
        if (m?.id != null) collect({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: err.message } });
      })
    : Promise.resolve(collect({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request object' } })))))
    .then(() => { if (replies.length) process.stdout.write(`${JSON.stringify(replies)}\n`); });
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

async function handle(msg, collect) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // A request with no id is a notification, whatever it asks for. The switch
  // below used to reply anyway — emitting a response with no `id` member, and a
  // success response with `id: null`, both invalid JSON-RPC. Worse, a
  // `tools/call` notification still WROTE: a mutation happened and the caller
  // was told nothing it could match to it.
  if (isNotification && method !== 'notifications/initialized' && method !== 'notifications/cancelled') {
    log(`ignoring ${method} sent without an id — a request that wants an answer needs one`);
    return;
  }

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
      }, collect);
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;                                   // notifications get no reply, ever
    case 'ping':
      return result(id, {}, collect);
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
      }, collect);
    case 'tools/call':
      // The only path that takes the lock, so the only one that queues.
      return result(id, await onWriteQueue(() => callTool(params)), collect);
    default:
      return error(id, -32601, `method not found: ${method}`, collect);
  }
}

/* ── stdio transport ─────────────────────────────────────── */
// Newline-delimited JSON. A chunk can hold several messages or half of one, so
// the tail is always carried over rather than parsed.
let buffer = '';
// Two chains, deliberately. Anything that touches the tracker is sequential,
// because two tool calls in flight would each take the lock and the second
// would just wait. But protocol frames must NOT sit behind that: the startup
// heartbeat was queued ahead of the handshake, so `initialize` could not answer
// until a tracker write completed — measured 5.8s behind a held lock and 62s
// when the lock was never released. A handshake bounded by the lock timeout is
// a server the client gives up on.
let writes = Promise.resolve();
const onWriteQueue = (fn) => {
  const run = writes.then(fn, fn);
  writes = run.then(() => {}, () => {});
  return run;
};

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
      // We negotiate protocol revisions in which JSON-RPC batching is legal, so
      // refusing them was advertising a version we did not implement.
      if (!msg.length) { error(null, -32600, 'an empty batch is not a request'); continue; }
      handleBatch(msg);
      continue;
    }
    Promise.resolve(handle(msg)).catch((err) => {
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
// Drain before exiting, twice over: the queued work has to finish, and then the
// bytes it produced have to reach the pipe. process.exit() discards whatever is
// still buffered, so a reply over 64KiB used to arrive truncated mid-JSON with
// exit code 0 — nothing signalled failure and the client threw on the frame.
function shutdown() {
  if (process.stdout.writableLength === 0) process.exit(0);
  const bail = setTimeout(() => process.exit(0), 5000);
  bail.unref?.();
  process.stdout.once('drain', () => process.exit(0));
}

process.stdin.on('end', () => { writes.then(shutdown, shutdown); });
// The client going away mid-write is a normal shutdown, not a crash.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') log(`stdout: ${err.message}`); });
process.on('uncaughtException', (err) => { log(`uncaught: ${err.stack}`); });

// Beat once at startup so the tag lights as soon as Claude Code connects,
// rather than up to a minute later. unref so the heartbeat alone never holds
// the process open.
onWriteQueue(beat);
const heart = setInterval(() => onWriteQueue(beat), HEARTBEAT_MS);
heart.unref?.();

log(`ready — ${TOOLS.length} tools, tracker ${TRACKER}`);
