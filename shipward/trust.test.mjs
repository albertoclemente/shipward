// Trust panel rules. Run: node --test
//
// SW-045. Every rule is pure, so git's answer and the working tree arrive as
// data and none of this needs a repository. The one thing that does — reading
// the tree — is git.mjs's, and it is already tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trustFindings, rankFindings, trustLede, checksBegan, STALE_REVIEW_DAYS, REPORTED_RULES,
} from './public/trust-lib.js';

const NOW = Date.parse('2026-07-31T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400_000).toISOString();

const card = (over = {}) => ({
  id: 'SW-001', p: 'shipward', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
  status: 'backlog', claude: null, branch: null, commit: null, note: [],
  created: daysAgo(30), pushed: null, shipped: null, ...over,
});

const rules = (out) => out.map((f) => f.rule);
const run = (cards, opts = {}) => trustFindings(cards, { now: NOW, ...opts });

/* ── what git can disprove but not settle ────────────────── */

test('only the reported tier reaches the panel', () => {
  // certain is applied at session start and proposed is what sync(apply) is
  // for. Neither is unsettled, so neither belongs on a panel about things
  // nobody can settle.
  assert.deepEqual([...REPORTED_RULES].sort(), ['not-on-trunk', 'untracked-branch']);
  const out = run([card({ id: 'SW-001', status: 'pushed', commit: 'deadbee' })], {
    findings: [
      { rule: 'merged-not-pushed', id: 'SW-001' },
      { rule: 'missing-commit', id: 'SW-001' },
      { rule: 'not-on-trunk', id: 'SW-001' },
    ],
  });
  assert.deepEqual(rules(out), ['not-on-trunk']);
});

test('a card claiming it landed names the commit git cannot find', () => {
  const [f] = run([card({ id: 'SW-007', status: 'pushed', commit: 'deadbee', title: 'The thing' })], {
    findings: [{ rule: 'not-on-trunk', id: 'SW-007' }],
  });
  assert.equal(f.card, 'SW-007');
  assert.match(f.headline, /SW-007 says it landed/);
  assert.match(f.detail, /deadbee/);
  assert.match(f.detail, /not which/, 'git can prove it is wrong, not what is right — the tier IS the message');
});

test('an unclaimed branch is a finding with no card to hang it on', () => {
  const [f] = run([], { findings: [{ rule: 'untracked-branch', branch: 'feat/ghost' }] });
  assert.equal(f.card, null, 'findings that name no card still have to render');
  assert.match(f.headline, /feat\/ghost/);
});

/* ── the working tree ────────────────────────────────────── */

test('files changed with nothing in flight', () => {
  const [f] = run([card({ status: 'backlog' })], { tree: { dirtyPaths: ['a.js', 'b.js'] } });
  assert.equal(f.rule, 'uncarded-changes');
  assert.match(f.headline, /2 files changed/);
  assert.match(f.detail, /a\.js, b\.js/);
});

test('the same files with a card in progress are just work', () => {
  const out = run([card({ status: 'claude', claude: 'working' })], { tree: { dirtyPaths: ['a.js'] } });
  assert.deepEqual(rules(out), []);
});

test('a clean tree says nothing', () => {
  assert.deepEqual(rules(run([card()], { tree: { dirtyPaths: [] } })), []);
  assert.deepEqual(rules(run([card()], { tree: null })), []);
});

/* ── board arithmetic ────────────────────────────────────── */

test('a review nobody has looked at for a week', () => {
  const [f] = run([card({ id: 'SW-010', status: 'review', note: [{ t: daysAgo(9), text: 'done' }] })]);
  assert.equal(f.rule, 'stale-review');
  assert.match(f.headline, /waiting on you for 9 days/);
});

test('a fresh review is not nagged', () => {
  assert.deepEqual(rules(run([card({ status: 'review', note: [{ t: daysAgo(2), text: 'done' }] })])), []);
});

test('the age is measured from when it was handed back, not when it was created', () => {
  // A card created a month ago and closed yesterday has been waiting one day.
  const out = run([card({ status: 'review', created: daysAgo(30), note: [{ t: daysAgo(1), text: 'done' }] })]);
  assert.deepEqual(rules(out), []);
});

test('the staleness threshold is a parameter, and its default is the documented one', () => {
  assert.equal(STALE_REVIEW_DAYS, 7);
  const c = [card({ status: 'review', note: [{ t: daysAgo(4), text: 'x' }] })];
  assert.deepEqual(rules(run(c)), []);
  assert.deepEqual(rules(run(c, { staleDays: 3 })), ['stale-review']);
});

/* ── unproven, without indicting the past ────────────────── */

const verified = (at) => ({ check: 'default', argv: ['node'], exit: 0, ok: true, at, sha: 'abc1234', dirty: false, ms: 1 });

test('checks began when the first verification was recorded, not when the code shipped', () => {
  assert.equal(checksBegan([card()]), null, 'a board that has never verified anything has no baseline');
  const began = checksBegan([
    card({ id: 'SW-001', verification: verified(daysAgo(3)) }),
    card({ id: 'SW-002', verification: verified(daysAgo(1)) }),
  ]);
  assert.equal(began, Date.parse(daysAgo(3)));
});

test('a card closed before checks existed is not indicted', () => {
  // The whole reason this is derived: on the day the panel shipped, 51 cards
  // predated verification. Listing them would fill the panel with the past and
  // teach a reader to close it.
  const out = run([
    card({ id: 'SW-001', status: 'pushed', pushed: daysAgo(20), verification: null }),
    card({ id: 'SW-002', status: 'pushed', pushed: daysAgo(1), verification: verified(daysAgo(1)) }),
  ]);
  assert.deepEqual(rules(out), []);
});

test('a card closed after checks began, with nothing recorded, is unproven', () => {
  const out = run([
    card({ id: 'SW-001', status: 'pushed', pushed: daysAgo(5), verification: verified(daysAgo(5)) }),
    card({ id: 'SW-002', status: 'review', note: [{ t: daysAgo(1), text: 'closed it' }] }),
  ]);
  assert.deepEqual(rules(out), ['never-verified']);
  assert.match(out[0].detail, /unproven/);
  assert.doesNotMatch(out[0].detail, /\bis wrong\b/, 'unproven is not an accusation, and the copy must not make it one');
});

test('cards still in flight are not unproven — they are unfinished', () => {
  const out = run([
    card({ id: 'SW-001', status: 'pushed', pushed: daysAgo(5), verification: verified(daysAgo(5)) }),
    card({ id: 'SW-002', status: 'claude', claude: 'working' }),
    card({ id: 'SW-003', status: 'backlog' }),
  ]);
  assert.deepEqual(rules(out), []);
});

/* ── presentation ────────────────────────────────────────── */

test('the false claim ranks above the merely unproven', () => {
  const out = rankFindings([
    { rule: 'never-verified', card: 'SW-002' },
    { rule: 'stale-review', card: 'SW-003' },
    { rule: 'not-on-trunk', card: 'SW-001' },
  ]);
  assert.deepEqual(rules(out), ['not-on-trunk', 'stale-review', 'never-verified']);
});

test('an empty panel says what was checked, not merely that it found nothing', () => {
  const text = trustLede([]);
  assert.match(text, /on the trunk/);
  assert.match(text, /Nothing unsettled/);
});

test('an unreadable repository never reads as all-clear', () => {
  // The same rule git.mjs holds: "we do not know" must not render as "nothing
  // is wrong".
  const text = trustLede([], { known: false });
  assert.doesNotMatch(text, /Nothing unsettled/);
  assert.match(text, /could not be read/);
});

test('the lede counts by rule so a reader knows the shape before reading', () => {
  const text = trustLede([
    { rule: 'not-on-trunk', card: 'SW-001' },
    { rule: 'stale-review', card: 'SW-002' },
    { rule: 'stale-review', card: 'SW-003' },
  ]);
  assert.match(text, /3 things/);
  assert.match(text, /1 claiming to have landed/);
  assert.match(text, /2 waiting too long/);
});
