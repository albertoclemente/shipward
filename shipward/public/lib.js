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

// Sort rather than trusting position: the file is newest-first by convention,
// but Claude Code writes it directly and an appended entry would otherwise
// surface an ancient message as the latest activity.
export const latestFeed = (feed, projectId) =>
  feed
    .filter((f) => f.p === projectId && !Number.isNaN(Date.parse(f.t)))
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))[0] || null;
