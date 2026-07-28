// Pure-logic tests for the Shipward board. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtDate, relTime, autoBranch, nextId, moveMsg, applyTransition,
  feedAdd, deriveColumns, deriveStats, latestFeed, feedDays, feedLede, messageParts, FEED_CAP,
  claudeSince, elapsedShort, filterFeed, fleetLinkFrom,
  archiveRows, archiveLede, mcpStatus, MCP_STALE_MS,
} from './public/lib.js';

const card = (over = {}) => ({
  id: 'SW-001', p: 'shipward', title: 'Brew timer with bloom alerts',
  type: 'feature', pri: 'P2', effort: 'M', status: 'backlog',
  claude: null, branch: null, commit: null,
  created: '2026-07-01T09:00:00Z', pushed: null, shipped: null, ...over,
});

test('nextId scans the max suffix, so deleted ids stay burned', () => {
  const cards = [card({ id: 'SW-001' }), card({ id: 'SW-007' }), card({ id: 'SW-003' })];
  assert.equal(nextId(cards, 'SW'), 'SW-008');
  // SW-007 deleted → counter must not fall back to 004
  assert.equal(nextId(cards.filter((c) => c.id !== 'SW-007'), 'SW'), 'SW-004');
});

test('nextId ignores other projects and starts at 001', () => {
  assert.equal(nextId([card({ id: 'BW-016' })], 'SW'), 'SW-001');
  assert.equal(nextId([], 'SW'), 'SW-001');
});

test('autoBranch mirrors the card type and takes three words', () => {
  assert.equal(autoBranch(card()), 'feat/brew-timer-with');
  assert.equal(autoBranch(card({ type: 'bug', title: 'Fix the broken poll loop' })), 'fix/fix-the-broken');
  assert.equal(autoBranch(card({ type: 'chore', title: 'Bump deps' })), 'chore/bump-deps');
  assert.equal(autoBranch(card({ title: 'Add "smart" "quotes" & symbols!' })), 'feat/add-smart-quotes');
});

test('moving to claude queues it and names a branch when empty', () => {
  const u = applyTransition(card(), 'claude', '2026-07-25T10:00:00Z');
  assert.equal(u.status, 'claude');
  assert.equal(u.claude, 'queued');
  assert.equal(u.branch, 'feat/brew-timer-with');
});

test('an existing branch survives the move to claude', () => {
  const u = applyTransition(card({ branch: 'feat/mine' }), 'claude', '2026-07-25T10:00:00Z');
  assert.equal(u.branch, 'feat/mine');
});

test('leaving claude settles the claude field', () => {
  const working = card({ status: 'claude', claude: 'working', branch: 'feat/x' });
  assert.equal(applyTransition(working, 'review', '2026-07-25T10:00:00Z').claude, 'done');
  assert.equal(applyTransition(working, 'backlog', '2026-07-25T10:00:00Z').claude, null);
  // already done → left alone
  const done = card({ status: 'review', claude: 'done' });
  assert.equal(applyTransition(done, 'pushed', '2026-07-25T10:00:00Z').claude, 'done');
});

test('pushed and shipped stamp their timestamps and never fake a sha', () => {
  const at = '2026-07-25T10:00:00Z';
  const pushed = applyTransition(card({ status: 'review' }), 'pushed', at);
  assert.equal(pushed.pushed, at);
  assert.equal(pushed.commit, null, 'commit belongs to Claude Code');

  const shipped = applyTransition(card({ status: 'pushed', pushed: at }), 'shipped', at);
  assert.equal(shipped.shipped, at);
  assert.equal(shipped.pushed, at, 'existing pushed timestamp is preserved');
});

test('dropping a card on the column it already occupies is a no-op', () => {
  assert.equal(applyTransition(card({ status: 'review' }), 'review', '2026-07-25T10:00:00Z'), null);
  assert.equal(applyTransition(null, 'review', '2026-07-25T10:00:00Z'), null);
});

test('feed copy is verbatim', () => {
  assert.equal(moveMsg('SW-004', 'claude'), 'SW-004 handed to Claude Code — queued');
  assert.equal(moveMsg('SW-004', 'review'), 'SW-004 moved to Review — give it a look');
  assert.equal(moveMsg('SW-004', 'pushed'), 'SW-004 landed on main — nice work');
  assert.equal(moveMsg('SW-004', 'shipped'), 'SW-004 filed to the archive');
  assert.equal(moveMsg('SW-004', 'backlog'), 'SW-004 sent back to Backlog');
});

test('feed is newest-first and capped at 200', () => {
  let feed = [];
  for (let i = 0; i < FEED_CAP + 25; i++) {
    feed = feedAdd(feed, 'shipward', `entry ${i}`, `2026-07-25T10:00:${String(i % 60).padStart(2, '0')}Z`);
  }
  assert.equal(feed.length, FEED_CAP);
  assert.equal(feed[0].msg, `entry ${FEED_CAP + 24}`, 'newest first');
  assert.equal(feed[0].by, 'user', 'UI writes are attributed to the human');
  assert.equal(feedAdd([], 'shipward', 'x', 'now', 'claude')[0].by, 'claude');
});

test('relative time thresholds, including the boundaries', () => {
  const now = new Date('2026-07-25T12:00:00Z').getTime();
  const ago = (s) => relTime(new Date(now - s * 1000).toISOString(), now);
  assert.equal(ago(10), 'just now');
  assert.equal(ago(89), 'just now');
  assert.equal(ago(90), '1m ago');
  assert.equal(ago(600), '10m ago');
  // floor, not round: these used to emit "60m ago" and "24h ago", which the
  // contract table has no row for
  assert.equal(ago(3599), '59m ago');
  assert.equal(ago(3600), '1h ago');
  assert.equal(ago(86399), '23h ago');
  assert.equal(ago(86400 * 3), 'Jul 22');
});

test('date helpers are timezone-independent and reject junk', () => {
  // These read UTC getters, so the result cannot depend on the runner's TZ.
  assert.equal(fmtDate('2026-07-04T00:00:00Z'), 'Jul 4');
  assert.equal(fmtDate('2026-08-01T02:00:00Z'), 'Aug 1');
  assert.equal(fmtDate(null), '');
  assert.equal(fmtDate('not a date'), '');
  assert.equal(relTime('not a date', Date.now()), '');
});

test('autoBranch never emits a bare prefix', () => {
  // Title strips to nothing → "feat/" would be an invalid git ref
  assert.equal(autoBranch(card({ id: 'SW-042', title: '🎉' })), 'feat/sw-042');
  assert.equal(autoBranch(card({ id: 'SW-042', title: '請求書バグ' })), 'feat/sw-042');
});

test('moving back out of production retracts the timestamps', () => {
  const at = '2026-07-25T10:00:00Z';
  const shipped = card({ status: 'pushed', pushed: at, shipped: null });
  const back = applyTransition(shipped, 'backlog', '2026-07-26T10:00:00Z');
  assert.equal(back.pushed, null, 'a Backlog card must not claim it was pushed');
  assert.equal(back.shipped, null);
});

test('stats ignore a stale timestamp on a card that moved back', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const stale = card({ id: 'SW-009', status: 'backlog', pushed: '2026-07-02T00:00:00Z' });
  assert.equal(deriveStats([stale], 'shipward', now).shipped, 0);
});

test('latestFeed sorts by time rather than trusting position', () => {
  const feed = [
    { t: '2026-07-01T00:00:00Z', p: 'shipward', msg: 'old' },
    { t: '2026-07-25T00:00:00Z', p: 'shipward', msg: 'new' },   // appended to the tail
    { t: '2026-07-26T00:00:00Z', p: 'brewnote', msg: 'other project' },
  ];
  assert.equal(latestFeed(feed, 'shipward').msg, 'new');
  assert.equal(latestFeed([], 'shipward'), null);
});

test('columns filter by project and carry their empty copy', () => {
  const cards = [
    card({ id: 'SW-001', status: 'backlog' }),
    card({ id: 'SW-002', status: 'claude' }),
    card({ id: 'SW-003', status: 'shipped' }),
    card({ id: 'BW-001', p: 'brewnote', status: 'backlog' }),
  ];
  const [backlog, claude, review, pushed] = deriveColumns(cards, 'shipward');
  assert.equal(backlog.count, 1, 'other projects excluded');
  assert.equal(claude.count, 1);
  assert.equal(review.count, 0);
  assert.equal(review.empty, 'Nothing to review — trust your past self.');
  assert.equal(pushed.isEmpty, true);
  assert.equal(backlog.cards.some((c) => c.status === 'shipped'), false, 'archived cards leave the board');
});

test('stats count in-flight, waiting, and this month only', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const cards = [
    card({ id: 'SW-001', status: 'claude' }),
    card({ id: 'SW-002', status: 'review' }),
    card({ id: 'SW-003', status: 'pushed', pushed: '2026-07-10T00:00:00Z' }),
    card({ id: 'SW-004', status: 'shipped', shipped: '2025-07-10T00:00:00Z' }), // same month, last year
    card({ id: 'SW-005', status: 'shipped', shipped: '2026-06-10T00:00:00Z' }),
  ];
  const s = deriveStats(cards, 'shipward', now);
  assert.equal(s.inFlight, 2);
  assert.equal(s.waiting, 1);
  assert.equal(s.shipped, 1, 'year must match too');
  assert.equal(s.line, '2 in flight · 1 waiting on you · 1 shipped this month');
});

test('archive rows hold only shipped cards, newest first', () => {
  const cards = [
    card({ id: 'SW-001', status: 'shipped', shipped: '2026-07-02T00:00:00Z', title: 'first out' }),
    card({ id: 'SW-002', status: 'pushed', pushed: '2026-07-09T00:00:00Z' }),
    card({ id: 'SW-003', status: 'shipped', shipped: '2026-07-20T00:00:00Z', commit: 'a1b2c3d' }),
    card({ id: 'BW-001', p: 'brewnote', status: 'shipped', shipped: '2026-07-30T00:00:00Z' }),
  ];
  const rows = archiveRows(cards, 'shipward');
  assert.deepEqual(rows.map((r) => r.id), ['SW-003', 'SW-001'], 'shipped only, newest first');
  assert.equal(rows[0].date, 'Jul 20');
  assert.equal(rows[0].commit, 'a1b2c3d');
  assert.equal(rows[1].commit, '—', 'a card with no sha still gets a cell');
  assert.equal(rows[1].title, 'first out');
});

test('an archive entry with no usable shipped date sinks, it does not scramble the order', () => {
  // Claude Code writes this file directly, so a hand-edited timestamp is real.
  const cards = [
    card({ id: 'SW-001', status: 'shipped', shipped: '2026-07-02T00:00:00Z' }),
    card({ id: 'SW-002', status: 'shipped', shipped: null }),
    card({ id: 'SW-003', status: 'shipped', shipped: 'last tuesday' }),
    card({ id: 'SW-004', status: 'shipped', shipped: '2026-07-11T00:00:00Z' }),
  ];
  const rows = archiveRows(cards, 'shipward');
  assert.deepEqual(rows.map((r) => r.id).slice(0, 2), ['SW-004', 'SW-001'], 'dated entries lead');
  assert.deepEqual(rows.slice(2).map((r) => r.date), ['', ''], 'undated entries sink with a blank cell');
});

test('archiveRows does not reorder the caller\'s array', () => {
  const cards = [
    card({ id: 'SW-001', status: 'shipped', shipped: '2026-07-02T00:00:00Z' }),
    card({ id: 'SW-002', status: 'shipped', shipped: '2026-07-20T00:00:00Z' }),
  ];
  archiveRows(cards, 'shipward');
  assert.deepEqual(cards.map((c) => c.id), ['SW-001', 'SW-002'], 'sort must not mutate the input');
});

test('the archive lede counts one entry as an entry', () => {
  assert.match(archiveLede('Shipward', 1), /— 1 entry and counting/);
  assert.match(archiveLede('Shipward', 0), /— 0 entries and counting/);
  assert.match(archiveLede('Brewnote', 12), /^Everything Brewnote has landed on main — 12 entries and counting\./);
});

test('the MCP tag is lit only while a server is actually heartbeating', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  const at = (ms) => ({ mcp: { lastSeen: new Date(now - ms).toISOString() } });

  assert.equal(mcpStatus(at(0), now).connected, true);
  assert.equal(mcpStatus(at(MCP_STALE_MS - 1), now).connected, true, 'one heartbeat may be missed');
  assert.equal(mcpStatus(at(MCP_STALE_MS + 1), now).connected, false);
  assert.equal(mcpStatus(at(MCP_STALE_MS + 1), now).label, 'MCP OFFLINE');

  // A tracker that has never seen the MCP server must not claim a connection —
  // the tag was hardcoded before this, which made it decoration.
  assert.equal(mcpStatus({}, now).connected, false);
  assert.equal(mcpStatus({ mcp: {} }, now).connected, false);
  assert.equal(mcpStatus({ mcp: { lastSeen: 'whenever' } }, now).connected, false);
  assert.equal(mcpStatus(undefined, now).connected, false);
});

test('a heartbeat from the future reads as live, not as infinitely stale', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  const ahead = { mcp: { lastSeen: new Date(now + 5000).toISOString() } };
  assert.equal(mcpStatus(ahead, now).connected, true, 'a disagreeing clock is not a dead server');
});

/* ── the log (SW-025) ────────────────────────────────────── */

const at = (t, msg, by = 'claude', p = 'shipward') => ({ t, p, msg, by });
const NOW = new Date('2026-07-28T14:00:00Z');

test('feedDays groups by UTC day, newest first', () => {
  const days = feedDays([
    at('2026-07-26T23:30:00Z', 'older'),
    at('2026-07-28T09:00:00Z', 'this morning'),
    at('2026-07-27T10:00:00Z', 'yesterday midmorning'),
    at('2026-07-28T11:00:00Z', 'later this morning'),
  ], 'shipward', { now: NOW });

  assert.deepEqual(days.map((d) => d.label), ['Today', 'Yesterday', 'Sun Jul 26']);
  assert.deepEqual(days[0].entries.map((e) => e.msg), ['later this morning', 'this morning']);
  assert.deepEqual(days[0].entries.map((e) => e.time), ['11:00', '09:00']);
});

test('feedDays groups in UTC, matching how the same date is displayed', () => {
  // 23:30Z is the 26th everywhere the tracker renders it. Grouping in local
  // time would file it under the 27th for any reader east of UTC while
  // fmtDate still said Jul 26 — one entry, two dates, in one view.
  const days = feedDays([at('2026-07-26T23:30:00Z', 'late')], 'shipward', { now: NOW });
  assert.equal(days[0].date, 'Jul 26');
  assert.equal(days[0].entries[0].time, '23:30');
});

test('feedDays ignores other projects and unparseable timestamps', () => {
  const days = feedDays([
    at('2026-07-28T09:00:00Z', 'mine'),
    at('2026-07-28T09:00:00Z', 'theirs', 'claude', 'other'),
    at('not a date', 'junk'),
  ], 'shipward', { now: NOW });
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].entries.map((e) => e.msg), ['mine']);
});

test('feedDays attributes honestly', () => {
  const days = feedDays([
    at('2026-07-28T09:00:00Z', 'a drag', 'user'),
    at('2026-07-28T08:00:00Z', 'a tool call', 'claude'),
  ], 'shipward', { now: NOW });
  assert.deepEqual(days[0].entries.map((e) => e.by), ['You', 'Claude Code']);
  assert.deepEqual(days[0].entries.map((e) => e.mine), [true, false]);
});

test('feedDays links only card ids that exist', () => {
  // "SW-024" and "UTF-8" are the same shape; only one of them is a card.
  const feed = [at('2026-07-28T09:00:00Z', 'SW-024 moved to Review, UTF-8 fixed in SW-999')];
  const loose = feedDays(feed, 'shipward', { now: NOW });
  assert.deepEqual(loose[0].entries[0].ids, ['SW-024', 'UTF-8', 'SW-999']);

  const checked = feedDays(feed, 'shipward', { now: NOW, ids: new Set(['SW-024']) });
  assert.deepEqual(checked[0].entries[0].ids, ['SW-024']);
});

test('feedDays does not repeat an id mentioned twice in one line', () => {
  const days = feedDays([at('2026-07-28T09:00:00Z', 'SW-024 superseded by SW-024')], 'shipward', { now: NOW });
  assert.deepEqual(days[0].entries[0].ids, ['SW-024']);
});

test('feedLede counts who did what, and says when the cap has bitten', () => {
  const days = feedDays([
    at('2026-07-28T09:00:00Z', 'a', 'user'),
    at('2026-07-28T08:00:00Z', 'b'),
    at('2026-07-27T08:00:00Z', 'c'),
  ], 'shipward', { now: NOW });

  assert.equal(feedLede(days), '3 entries over 2 days, 2 by Claude Code, 1 by you.');
  assert.match(feedLede(days, { capped: true }),
    new RegExp(`most recent ${FEED_CAP} — older entries live in .shipward/feed-archive.jsonl`));

  // "1 entries" reads like a bug in a product whose whole pitch is care.
  const solo = feedDays([at('2026-07-28T09:00:00Z', 'a')], 'shipward', { now: NOW });
  assert.equal(feedLede(solo), '1 entry in one day, written by Claude Code.');

  const yours = feedDays([
    at('2026-07-28T09:00:00Z', 'a', 'user'),
    at('2026-07-28T08:00:00Z', 'b', 'user'),
  ], 'shipward', { now: NOW });
  assert.equal(feedLede(yours), '2 entries in one day, every one written by you.');
});

test('feedLede says something useful when there is nothing', () => {
  assert.match(feedLede([]), /fills itself as work moves/);
});

test('messageParts makes the id in the sentence the link, not a copy of it', () => {
  // The first cut appended a chip per line, rendering the same id twice — once
  // as prose, once as a button — in a view whose whole job is reading cleanly.
  const parts = messageParts('SW-025 moved to Review', new Set(['SW-025']));
  assert.deepEqual(parts, [{ id: 'SW-025' }, { text: ' moved to Review' }]);

  assert.deepEqual(
    messageParts('fixed SW-001 and SW-002 today', new Set(['SW-001', 'SW-002'])),
    [{ text: 'fixed ' }, { id: 'SW-001' }, { text: ' and ' }, { id: 'SW-002' }, { text: ' today' }],
  );
});

test('messageParts leaves a message with no ids in one piece', () => {
  assert.deepEqual(messageParts('23 cards filed to the archive', new Set(['SW-001'])),
    [{ text: '23 cards filed to the archive' }]);
  // An id-shaped token that is not a card stays as text rather than becoming a
  // button that opens nothing.
  assert.deepEqual(messageParts('fixed the UTF-8 handling', new Set(['SW-001'])),
    [{ text: 'fixed the UTF-8 handling' }]);
});

test('rejoining the parts reproduces the message exactly', () => {
  for (const msg of [
    'SW-025 moved to Review — give it a look',
    'Reconciled with git — SW-024 → claude',
    'no ids at all here',
    'SW-001',
  ]) {
    const back = messageParts(msg, new Set(['SW-001', 'SW-024', 'SW-025']))
      .map((p) => p.id || p.text).join('');
    assert.equal(back, msg, 'no character may be dropped or duplicated in the split');
  }
});

/* ── product-fit helpers (SW-031) ────────────────────────── */

test('claudeSince reads the start from the feed, newest take wins', () => {
  const feed = [
    at('2026-07-28T10:00:00Z', 'SW-031 handed to Claude Code — queued'),
    at('2026-07-27T09:00:00Z', 'SW-031 handed to Claude Code — queued'),
    at('2026-07-28T11:00:00Z', 'SW-030 handed to Claude Code — queued'),
    at('2026-07-28T12:00:00Z', 'SW-031 moved to Review — give it a look'),
    at('2026-07-28T13:00:00Z', 'SW-031 handed to Claude Code — queued', 'claude', 'other'),
  ];
  assert.equal(claudeSince(feed, 'shipward', 'SW-031'), '2026-07-28T10:00:00Z');
  assert.equal(claudeSince(feed, 'shipward', 'SW-099'), null, 'rolled off or never started: no clock, not a guess');
});

test('elapsedShort is a duration, not an ago-time', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(elapsedShort('2026-07-28T11:59:40Z', now), 'just now');
  assert.equal(elapsedShort('2026-07-28T11:46:00Z', now), '14m');
  assert.equal(elapsedShort('2026-07-28T09:00:00Z', now), '3h');
  assert.equal(elapsedShort('2026-07-26T09:00:00Z', now), '2d');
  assert.equal(elapsedShort('not a date', now), '');
  assert.equal(elapsedShort('2026-07-28T13:00:00Z', now), '', 'a start in the future renders nothing rather than a negative');
});

test('filterFeed by author follows the same rule the labels use', () => {
  const feed = [
    at('2026-07-28T10:00:00Z', 'by claude'),
    at('2026-07-28T09:00:00Z', 'by user', 'user'),
    { t: '2026-07-28T08:00:00Z', p: 'shipward', msg: 'by nobody' },   // by omitted — reads as Claude
  ];
  assert.deepEqual(filterFeed(feed, { by: 'user' }).map((f) => f.msg), ['by user']);
  assert.deepEqual(filterFeed(feed, { by: 'claude' }).map((f) => f.msg), ['by claude', 'by nobody']);
  assert.equal(filterFeed(feed, {}).length, 3);
});

test('filterFeed query matches the message text, case-insensitively', () => {
  const feed = [
    at('2026-07-28T10:00:00Z', 'SW-024 moved to Review'),
    at('2026-07-28T09:00:00Z', 'Reconciled with git'),
  ];
  assert.deepEqual(filterFeed(feed, { query: 'sw-024' }).map((f) => f.msg), ['SW-024 moved to Review']);
  assert.deepEqual(filterFeed(feed, { query: '  ' }).length, 2, 'whitespace is no filter');
  assert.deepEqual(filterFeed(feed, { by: 'claude', query: 'reconciled' }).map((f) => f.msg), ['Reconciled with git']);
});

test('fleetLinkFrom accepts only a local origin — an href from a query param earns paranoia', () => {
  assert.equal(fleetLinkFrom('?fleet=http%3A%2F%2Flocalhost%3A4740'), 'http://localhost:4740');
  assert.equal(fleetLinkFrom('?fleet=http://127.0.0.1:4740'), 'http://127.0.0.1:4740');
  for (const evil of [
    '?fleet=https://evil.example', '?fleet=http://localhost:4740/phish',
    '?fleet=javascript:alert(1)', '?fleet=http://localhost.evil.com:80', '', null,
  ]) {
    assert.equal(fleetLinkFrom(evil), null, `${evil} must not become a link`);
  }
});
