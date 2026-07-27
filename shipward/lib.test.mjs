// Pure-logic tests for the Shipward board. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtDate, relTime, autoBranch, nextId, moveMsg, applyTransition,
  feedAdd, deriveColumns, deriveStats, latestFeed, FEED_CAP,
  archiveRows, archiveLede, rawJson, mcpStatus, MCP_STALE_MS,
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
  assert.equal(moveMsg('SW-004', 'pushed'), 'SW-004 pushed to production — nice work');
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
  assert.match(archiveLede('Brewnote', 12), /^Everything Brewnote has pushed to production — 12 entries and counting\./);
});

test('raw JSON emits the contract field order, renames pri, and drops p and note', () => {
  const cards = [
    card({ id: 'SW-001', pri: 'P1', note: 'context Claude keeps', branch: 'feat/x', commit: 'abc1234' }),
    card({ id: 'BW-001', p: 'brewnote' }),
  ];
  const out = rawJson(cards, 'shipward');
  const parsed = JSON.parse(out);

  assert.equal(parsed.length, 1, 'scoped to the active project');
  assert.deepEqual(Object.keys(parsed[0]), [
    'id', 'title', 'type', 'priority', 'effort', 'status',
    'claude', 'branch', 'commit', 'created', 'pushed', 'shipped',
  ]);
  assert.equal(parsed[0].priority, 'P1', 'pri is emitted as priority');
  assert.equal('pri' in parsed[0], false);
  assert.equal('p' in parsed[0], false, 'the view is already project-scoped');
  assert.equal('note' in parsed[0], false, 'note is Claude context, not board data');
  assert.equal(out, JSON.stringify(parsed, null, 2), 'pretty-printed with 2 spaces');
});

test('raw JSON keeps nulls rather than dropping the keys', () => {
  // A machine reading this needs the shape to be stable, so an unset field is
  // an explicit null, not an absent key.
  const [only] = JSON.parse(rawJson([card({ id: 'SW-001' })], 'shipward'));
  assert.equal(only.claude, null);
  assert.equal(only.branch, null);
  assert.equal(only.commit, null);
  assert.equal(only.pushed, null);
  assert.equal(only.shipped, null);
});

test('raw JSON of an empty project is an empty array, not a crash', () => {
  assert.equal(rawJson([], 'shipward'), '[]');
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
