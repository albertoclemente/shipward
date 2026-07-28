// Pure tracker logic. No DOM, no fetch — imported by app.js in the browser and
// by lib.test.mjs under `node --test`.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const COLUMNS = [
  { key: 'backlog', label: 'Backlog', hint: 'ideas & queued work', empty: 'Backlog is clear — dream something up.' },
  { key: 'claude', label: 'Claude working', hint: 'delegated over MCP', empty: 'Claude is idle. Drag a card here to delegate.' },
  { key: 'review', label: 'Review', hint: 'your eyes on it', empty: 'Nothing to review — trust your past self.' },
  { key: 'pushed', label: 'Pushed', hint: 'in production', empty: 'The next push lands here.' },
];

export const FEED_CAP = 200;

// Timestamps are UTC (ISO 8601 with Z). Read them with UTC getters — local
// getters made rendering depend on the reader's timezone, so a card shipped
// 2026-08-01T02:00Z displayed as "Jul 31" west of UTC and counted toward the
// wrong month.
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Thresholds per interaction-rules.md. Floor, not round: rounding emitted
// "60m ago" for the last minute of every hour and "24h ago" for the last hour
// of every day — strings the contract table has no row for.
export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = (now - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(iso);
}

export function autoBranch(card) {
  const prefix = card.type === 'bug' ? 'fix' : card.type === 'chore' ? 'chore' : 'feat';
  const words = (card.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  // A title of only non-Latin script or emoji strips to nothing; fall back to
  // the card id rather than writing "feat/", which is not a valid git ref.
  return `${prefix}/${words.join('-') || String(card.id || 'card').toLowerCase()}`;
}

// Ids are never reused: scan every card carrying this prefix, archived included,
// so a deleted id stays burned.
export function nextId(cards, prefix) {
  let max = 0;
  for (const c of cards) {
    if (typeof c.id !== 'string' || !c.id.startsWith(`${prefix}-`)) continue;
    const n = parseInt(c.id.slice(prefix.length + 1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// The header tag tells the truth about the MCP server, which is the whole
// premise of the product — a decorative "CONNECTED" that is lit whether or not
// anything is listening is worse than no tag at all.
//
// The server stamps doc.mcp.lastSeen while it runs. The window is generous
// relative to the 60s heartbeat, so one slow write or a stalled poll does not
// flicker the tag; a genuinely dead server goes dark within two and a half
// minutes.
export const MCP_STALE_MS = 150000;

export function mcpStatus(doc, now = Date.now()) {
  const seen = Date.parse(doc?.mcp?.lastSeen);
  if (Number.isNaN(seen)) return { connected: false, label: 'MCP OFFLINE', lastSeen: null };
  // A timestamp from the future is a clock that disagrees, not a live server;
  // treat it as seen now rather than as infinitely stale.
  const age = Math.max(0, now - seen);
  return {
    connected: age <= MCP_STALE_MS,
    label: age <= MCP_STALE_MS ? 'MCP CONNECTED' : 'MCP OFFLINE',
    lastSeen: doc.mcp.lastSeen,
  };
}

// Feed copy lives here, not at the call sites: the board and the MCP server
// both write these lines, and two copies of a string drift.
export const addMsg = (id) => `You added ${id} to Backlog — it's on the list`;
export const editMsg = (id, fields) => `${id} edited — ${fields}`;
export const deleteMsg = (id) => `${id} deleted — one less thing`;

export function moveMsg(id, status) {
  switch (status) {
    case 'claude': return `${id} handed to Claude Code — queued`;
    case 'review': return `${id} moved to Review — give it a look`;
    case 'pushed': return `${id} pushed to production — nice work`;
    case 'shipped': return `${id} filed to the archive`;
    default: return `${id} sent back to Backlog`;
  }
}

// Returns the updated card, or null when the move is a no-op (already there).
// `commit` is deliberately never set here — Claude Code owns it.
export function applyTransition(card, to, nowIso) {
  if (!card || card.status === to) return null;
  const u = { ...card, status: to };
  if (to === 'claude') {
    u.claude = 'queued';
    if (!u.branch) u.branch = autoBranch(card);
  } else if (card.claude === 'queued' || card.claude === 'working') {
    u.claude = to === 'backlog' ? null : 'done';
  }
  if (to === 'pushed' && !u.pushed) u.pushed = nowIso;
  if (to === 'shipped' && !u.shipped) u.shipped = nowIso;
  // Dragging back out of production retracts the claim. Without this a card
  // sitting in Backlog kept counting toward "N shipped this month" forever.
  if (to === 'backlog' || to === 'claude' || to === 'review') {
    u.pushed = null;
    u.shipped = null;
  }
  return u;
}

export function feedAdd(feed, projectId, msg, nowIso, by = 'user') {
  return [{ t: nowIso, p: projectId, msg, by }, ...feed].slice(0, FEED_CAP);
}

export const cardsOf = (cards, projectId) => cards.filter((c) => c.p === projectId);

export function deriveColumns(cards, projectId) {
  const mine = cardsOf(cards, projectId);
  return COLUMNS.map((d) => {
    const list = mine.filter((c) => c.status === d.key);
    return { ...d, count: list.length, cards: list, isEmpty: list.length === 0 };
  });
}

export function deriveStats(cards, projectId, now = new Date()) {
  const mine = cardsOf(cards, projectId);
  const inFlight = mine.filter((c) => c.status === 'claude' || c.status === 'review').length;
  const waiting = mine.filter((c) => c.status === 'review').length;
  // Month AND year — the prototype compared only getMonth(), so last July
  // counted toward this July.
  const shipped = mine.filter((c) => {
    if (c.status !== 'pushed' && c.status !== 'shipped') return false;
    const t = c.shipped || c.pushed;
    if (!t) return false;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return false;
    return d.getUTCMonth() === now.getUTCMonth() && d.getUTCFullYear() === now.getUTCFullYear();
  }).length;
  return { inFlight, waiting, shipped, line: `${inFlight} in flight · ${waiting} waiting on you · ${shipped} shipped this month` };
}

// Archive rows: shipped cards, newest first. An entry with a missing or
// unparseable `shipped` sinks to the bottom rather than scrambling the order —
// Claude Code writes this file directly, so a hand-edited timestamp is possible.
const shippedAt = (c) => {
  const t = Date.parse(c.shipped);
  return Number.isNaN(t) ? -Infinity : t;
};

export function archiveRows(cards, projectId) {
  return cardsOf(cards, projectId)
    .filter((c) => c.status === 'shipped')
    .sort((a, b) => shippedAt(b) - shippedAt(a))
    .map((c) => ({
      id: c.id,
      date: fmtDate(c.shipped),
      title: c.title,
      type: c.type,
      effort: c.effort,
      commit: c.commit || '—',
    }));
}

export function archiveLede(projectName, count) {
  // "1 entries" reads like a bug in a product whose whole pitch is care.
  const entries = count === 1 ? '1 entry' : `${count} entries`;
  return `Everything ${projectName} has pushed to production — ${entries} and counting. Look how far it's come.`;
}

// Sort rather than trusting position: the file is newest-first by convention,
// but Claude Code writes it directly and an appended entry would otherwise
// surface an ancient message as the latest activity.
export const latestFeed = (feed, projectId) =>
  feed
    .filter((f) => f.p === projectId && !Number.isNaN(Date.parse(f.t)))
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))[0] || null;

/* ── the log ─────────────────────────────────────────────── */
// The board answers "where does this stand". The log answers "what happened",
// which is the only one of the two that can show you a day you were not there
// for. The tracker has been keeping this the whole time and the desk rendered
// exactly one line of it.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// UTC, like fmtDate and for the same reason: grouping in local time while
// displaying in UTC would file an entry under one date and label it another.
const dayKey = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
const two = (n) => String(n).padStart(2, '0');

function dayLabel(d, now) {
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86400000))) return 'Yesterday';
  return `${DAY_NAMES[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Card ids inside a feed message, so a line can point back at the work. Matched
// against the ids that actually exist rather than trusted from the pattern:
// "SW-024" and "UTF-8" are the same shape, and only one of them is a card.
const ID_SHAPE = /\b[A-Z][A-Z0-9]{0,5}-\d{1,6}\b/g;

// The message split around its ids, so the id ALREADY IN the sentence becomes
// the link. The first cut of this appended a chip after each line, which
// rendered "SW-025 logged and taken — …  SW-025": the same id twice, once as
// prose and once as a button, in a view whose whole job is reading cleanly.
export function messageParts(msg, keep = null) {
  const text = String(msg);
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(ID_SHAPE)) {
    if (keep && !keep.has(m[0])) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ id: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function feedDays(feed, projectId, { now = new Date(), ids = null } = {}) {
  const entries = feed
    .filter((f) => f.p === projectId && !Number.isNaN(Date.parse(f.t)))
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t));

  const days = [];
  let current = null;
  for (const f of entries) {
    const d = new Date(f.t);
    const key = dayKey(d);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(d, now), date: fmtDate(f.t), entries: [] };
      days.push(current);
    }
    const parts = messageParts(f.msg, ids);
    current.entries.push({
      t: f.t,
      time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`,
      by: f.by === 'user' ? 'You' : 'Claude Code',
      mine: f.by === 'user',
      msg: f.msg,
      parts,
      ids: [...new Set(parts.filter((p) => p.id).map((p) => p.id))],
    });
  }
  return days;
}

export function feedLede(days, { capped = false } = {}) {
  const all = days.flatMap((d) => d.entries);
  if (!all.length) return 'Nothing logged yet. This fills itself as work moves — you never write to it.';

  const mine = all.filter((e) => e.mine).length;
  const theirs = all.length - mine;
  const one = all.length === 1;
  // "1 entries" reads like a bug in a product whose whole pitch is care —
  // the same reason archiveLede spells this out.
  const count = one ? '1 entry' : `${all.length} entries`;
  const span = days.length === 1 ? 'in one day' : `over ${days.length} days`;
  const who = !mine ? (one ? 'written by Claude Code' : 'every one written by Claude Code')
    : !theirs ? (one ? 'written by you' : 'every one written by you')
      : `${theirs} by Claude Code, ${mine} by you`;
  // The cap is not a footnote. A view calling itself the whole history has to
  // say when it is not one, or it becomes a lie the first time the cap bites.
  const rolled = capped
    ? ` This is the most recent ${FEED_CAP} — anything older has rolled off.`
    : '';
  return `${count} ${span}, ${who}.${rolled}`;
}
