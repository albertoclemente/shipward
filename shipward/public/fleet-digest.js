// One standup across every board.
//
// SW-046. The fleet has always listed boards; it has never answered anything
// that needs more than one at a time. These are the cross-repo questions —
// what is in flight anywhere, what has been waiting longest anywhere, which
// repo has gone quiet — and they are the axis the 2026-07-10 sweep found
// agent-native tools worst at. Claude Code's own task system structurally
// cannot reach it: no repo awareness, and task-list ids that collide.
//
// Pure, like fleet-view: the rows arrive as data and this decides what they
// add up to. Nothing here reads a file or a clock it was not given.

// A board with nothing pushed for this long is not necessarily neglected — it
// may simply be finished. The digest says "quiet", never "stale", because only
// the human knows which.
export const QUIET_DAYS = 21;
const DAY_MS = 86400_000;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const boardsOf = (rows) => (rows || []).filter((r) => r?.kind === 'board' && r.ok);

export const daysSince = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
};

// Everything a card is doing, wherever it lives. The board's name travels with
// each card because that is the whole point — a list of ids with no repo is
// exactly what the per-repo desks already give you.
export function inFlight(rows) {
  const out = [];
  for (const b of boardsOf(rows)) {
    for (const c of b.inFlight || []) out.push({ ...c, board: b.name, repo: b.repo, desk: b.desk });
  }
  // Working before queued: something a session is actually holding outranks
  // something merely claimed.
  const rank = { working: 0, queued: 1, done: 2 };
  return out.sort((a, b) => (rank[a.claude] ?? 9) - (rank[b.claude] ?? 9)
    || String(a.board).localeCompare(String(b.board)));
}

// Oldest first — the question is "what has been waiting longest", so an
// undated review sorts last rather than poisoning the order (Date.parse of a
// missing date is NaN, and one NaN scrambles its neighbours).
export function waiting(rows, now) {
  const out = [];
  for (const b of boardsOf(rows)) {
    for (const c of b.waiting || []) {
      out.push({ ...c, board: b.name, repo: b.repo, desk: b.desk, days: daysSince(c.since, now) });
    }
  }
  return out.sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
}

// Boards that have shipped nothing lately, and boards that have shipped nothing
// EVER — different facts, kept apart. A board with no pushed card at all is
// usually one that was onboarded and not yet used, which is not the same as one
// that has gone dark.
export function quiet(rows, now, quietDays = QUIET_DAYS) {
  const out = [];
  for (const b of boardsOf(rows)) {
    const days = b.lastShipped ? daysSince(b.lastShipped, now) : null;
    if (days === null) {
      if (!b.everShipped) out.push({ board: b.name, repo: b.repo, days: null, never: true });
      continue;
    }
    if (days >= quietDays) out.push({ board: b.name, repo: b.repo, days, never: false });
  }
  return out.sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));
}

export function digest(rows, { now = Date.now(), quietDays = QUIET_DAYS, found = null } = {}) {
  const boards = boardsOf(rows);
  const all = (rows || []).filter((r) => r?.kind === 'board');
  return {
    boards: boards.length,
    unreadable: all.length - boards.length,
    candidates: (rows || []).length - all.length,
    // Reported, never assumed: the fleet spawns at most MAX_DESKS desks and
    // used to drop the rest with no mention anywhere. A digest that says
    // "everywhere" while silently ignoring a board is a lie, and a silent cap
    // reads as full coverage.
    missing: found != null && found > all.length ? found - all.length : 0,
    inFlight: inFlight(rows),
    waiting: waiting(rows, now),
    quiet: quiet(rows, now, quietDays),
  };
}

// The one line at the top. Leads with work in flight because that is the only
// category that is happening right now.
export function digestLede(d) {
  if (!d.boards) return 'No boards to report on yet.';
  const bits = [];
  bits.push(d.inFlight.length
    ? `${plural(d.inFlight.length, 'card')} in flight across ${plural(new Set(d.inFlight.map((c) => c.board)).size, 'board')}`
    : 'Nothing in flight anywhere');
  if (d.waiting.length) bits.push(`${d.waiting.length} waiting on you`);
  if (d.quiet.length) bits.push(`${d.quiet.length} gone quiet`);
  let text = `${bits.join(' · ')}.`;
  if (d.unreadable) text += ` ${plural(d.unreadable, 'board')} could not be read.`;
  if (d.missing) {
    text += ` ${plural(d.missing, 'board')} found but not shown — the fleet runs at most 16 desks at once.`;
  }
  return text;
}

// Rendered as sections rather than one blob: each answers a different question
// and a reader wants only one of them at a time. Empty sections are dropped —
// "0 waiting on you" is noise on a fleet where that is the normal state.
export function digestSections(d) {
  const out = [];
  if (d.inFlight.length) {
    out.push({
      key: 'in-flight',
      heading: `In flight · ${d.inFlight.length}`,
      items: d.inFlight.map((c) => ({
        board: c.board,
        text: `${c.id} ${c.claude || 'queued'} — ${c.title}`,
        href: c.desk || null,
      })),
    });
  }
  if (d.waiting.length) {
    out.push({
      key: 'waiting',
      heading: `Waiting on you · ${d.waiting.length}`,
      items: d.waiting.map((c) => ({
        board: c.board,
        text: c.days == null ? `${c.id} — ${c.title}` : `${c.id} · ${plural(c.days, 'day')} — ${c.title}`,
        href: c.desk || null,
      })),
    });
  }
  if (d.quiet.length) {
    out.push({
      key: 'quiet',
      heading: `Gone quiet · ${d.quiet.length}`,
      items: d.quiet.map((q) => ({
        board: q.board,
        text: q.never ? 'nothing pushed yet' : `nothing pushed for ${plural(q.days, 'day')}`,
        href: null,
      })),
    });
  }
  return out;
}
