// One standup across every board. Run: node --test
//
// SW-046. Pure, so the cross-repo answers can be exercised without ten
// repositories and without a clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digest, digestLede, digestSections, inFlight, waiting, quiet, daysSince, QUIET_DAYS,
} from './public/fleet-digest.js';

const NOW = Date.parse('2026-07-31T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400_000).toISOString();

const board = (over = {}) => ({
  kind: 'board', ok: true, name: 'Shipward', repo: '/p/shipward_app',
  desk: 'http://localhost:4747/', working: 0, review: 0, backlog: 0, pushed: 0,
  inFlight: [], waiting: [], lastShipped: daysAgo(1), everShipped: true, ...over,
});

const d = (rows, opts = {}) => digest(rows, { now: NOW, ...opts });

/* ── in flight, everywhere ───────────────────────────────── */

test('cards in flight carry the board they belong to', () => {
  // Without the board name this is just a list of ids, which the per-repo desk
  // already gives you — the repo IS the answer here.
  const out = inFlight([
    board({ name: 'Shipward', inFlight: [{ id: 'SW-046', title: 'Fleet', claude: 'working' }] }),
    board({ name: 'Catch', inFlight: [{ id: 'CA-016', title: 'Pantry', claude: 'queued' }] }),
  ]);
  assert.deepEqual(out.map((c) => `${c.board} ${c.id}`), ['Shipward SW-046', 'Catch CA-016']);
});

test('work a session is holding outranks work merely claimed', () => {
  const out = inFlight([
    board({ name: 'A', inFlight: [{ id: 'A-001', claude: 'queued' }] }),
    board({ name: 'B', inFlight: [{ id: 'B-001', claude: 'working' }] }),
  ]);
  assert.deepEqual(out.map((c) => c.id), ['B-001', 'A-001']);
});

test('boards that could not be read contribute nothing rather than throwing', () => {
  assert.deepEqual(inFlight([{ kind: 'board', ok: false, error: 'unreadable' }]), []);
  assert.deepEqual(inFlight([{ kind: 'candidate' }]), []);
  assert.deepEqual(inFlight(null), []);
});

/* ── waiting longest, anywhere ───────────────────────────── */

test('reviews sort oldest first across every board', () => {
  const out = waiting([
    board({ name: 'A', waiting: [{ id: 'A-001', title: 'x', since: daysAgo(2) }] }),
    board({ name: 'B', waiting: [{ id: 'B-001', title: 'y', since: daysAgo(11) }] }),
  ], NOW);
  assert.deepEqual(out.map((c) => `${c.board} ${c.id}`), ['B B-001', 'A A-001']);
  assert.deepEqual(out.map((c) => c.days), [11, 2]);
});

test('an undated review sorts last instead of scrambling the order', () => {
  // Date.parse of a missing date is NaN, and one NaN comparison is enough to
  // leave the neighbours in arbitrary order.
  const out = waiting([
    board({ name: 'A', waiting: [{ id: 'A-001', since: null }] }),
    board({ name: 'B', waiting: [{ id: 'B-001', since: daysAgo(9) }] }),
    board({ name: 'C', waiting: [{ id: 'C-001', since: daysAgo(3) }] }),
  ], NOW);
  assert.deepEqual(out.map((c) => c.id), ['B-001', 'C-001', 'A-001']);
  assert.equal(out[2].days, null);
});

/* ── gone quiet ──────────────────────────────────────────── */

test('a board that has not shipped in three weeks is quiet', () => {
  const out = quiet([board({ name: 'Old', lastShipped: daysAgo(30) })], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].days, 30);
  assert.equal(out[0].never, false);
});

test('a board that shipped yesterday is not', () => {
  assert.deepEqual(quiet([board({ lastShipped: daysAgo(1) })], NOW), []);
});

test('never shipped and gone quiet are different facts', () => {
  // An onboarded-but-unused board is not a neglected one, and the copy must
  // not blur them.
  const out = quiet([board({ name: 'Fresh', lastShipped: null, everShipped: false })], NOW);
  assert.equal(out[0].never, true);
  assert.equal(out[0].days, null);
});

test('the quiet threshold is a parameter, and its default is the documented one', () => {
  assert.equal(QUIET_DAYS, 21);
  const rows = [board({ lastShipped: daysAgo(10) })];
  assert.deepEqual(quiet(rows, NOW), []);
  assert.equal(quiet(rows, NOW, 7).length, 1);
});

/* ── the digest as a whole ───────────────────────────────── */

test('the digest counts boards, unreadable boards and candidates apart', () => {
  const out = d([
    board(),
    { kind: 'board', ok: false, error: 'unreadable' },
    { kind: 'candidate', name: 'x' },
  ]);
  assert.equal(out.boards, 1);
  assert.equal(out.unreadable, 1);
  assert.equal(out.candidates, 1);
});

test('boards the fleet found but did not show are REPORTED, never dropped silently', () => {
  // The desk cap used to discard boards past MAX_DESKS with no mention. A
  // cross-repo answer that omits a repo without saying so reads as full
  // coverage, which is the one thing this view must never do.
  const out = d([board()], { found: 18 });
  assert.equal(out.missing, 17);
  assert.match(digestLede(out), /17 boards found but not shown/);
});

test('nothing missing says nothing about missing', () => {
  const out = d([board()], { found: 1 });
  assert.equal(out.missing, 0);
  assert.doesNotMatch(digestLede(out), /not shown/);
});

test('the lede leads with what is happening now', () => {
  const text = digestLede(d([
    board({ name: 'A', inFlight: [{ id: 'A-1', claude: 'working' }] }),
    board({ name: 'B', inFlight: [{ id: 'B-1', claude: 'working' }], waiting: [{ id: 'B-2', since: daysAgo(9) }] }),
  ]));
  assert.match(text, /^2 cards in flight across 2 boards/);
  assert.match(text, /1 waiting on you/);
});

test('a quiet fleet says so plainly', () => {
  assert.match(digestLede(d([board()])), /^Nothing in flight anywhere/);
});

test('an unreadable board is named in the lede, because silence would hide it', () => {
  const text = digestLede(d([board(), { kind: 'board', ok: false, error: 'x' }]));
  assert.match(text, /1 board could not be read/);
});

test('no boards at all is not reported as an all-clear', () => {
  assert.match(digestLede(d([])), /No boards/);
});

/* ── sections ────────────────────────────────────────────── */

test('empty sections are dropped rather than rendered as zero', () => {
  const secs = digestSections(d([board()]));
  assert.deepEqual(secs, [], '"0 waiting on you" is noise on a fleet where that is normal');
});

test('each section names its board and links to that desk', () => {
  const secs = digestSections(d([
    board({ name: 'Shipward', inFlight: [{ id: 'SW-046', title: 'Fleet', claude: 'working' }] }),
  ]));
  assert.equal(secs[0].heading, 'In flight · 1');
  assert.equal(secs[0].items[0].board, 'Shipward');
  assert.match(secs[0].items[0].text, /SW-046 working — Fleet/);
  assert.equal(secs[0].items[0].href, 'http://localhost:4747/');
});

test('a waiting item states its age, and one day is not "1 days"', () => {
  const secs = digestSections(d([
    board({ name: 'A', waiting: [{ id: 'A-1', title: 'x', since: daysAgo(1) }] }),
  ]));
  assert.match(secs[0].items[0].text, /A-1 · 1 day — x/);
});

test('a quiet board says which kind of quiet it is', () => {
  const [sec] = digestSections(d([
    board({ name: 'Never', lastShipped: null, everShipped: false }),
  ]));
  assert.match(sec.items[0].text, /nothing pushed yet/);
});

test('daysSince refuses to invent a number', () => {
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince('not a date', NOW), null);
  assert.equal(daysSince(daysAgo(5), NOW), 5);
});
