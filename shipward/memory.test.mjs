// Memory view logic. Run: node --test
//
// The classifier reads prose Claude wrote freely, so these tests use the real
// shapes that appear in the live tracker rather than tidy invented ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, refs, memoryEntries, groupByKind, fileIndex, searchEntries, memoryLede, stillOpen, SEGMENT_SEP,
} from './public/memory-lib.js';

const card = (over = {}) => ({
  id: 'SW-001', p: 'shipward', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
  status: 'review', claude: 'done', branch: null, commit: null, note: '',
  created: '2026-07-25T09:00:00Z', pushed: null, shipped: null, ...over,
});

test('a segment takes the kind that would cost most to miss', () => {
  // Verbatim shape from SW-011: an outcome, its evidence, and an open item, all
  // in one appended segment. The open item is what a reader must not scroll past.
  const real = 'REMOVED. app.js loses renderRaw. 81 tests pass. VERIFIED in the browser. '
    + 'LEFT STALE FOR ALBERTO: SPEC CAP-5 still describes a view that no longer exists.';
  assert.equal(classify(real), 'open');

  assert.equal(classify('SHIPPED: the archive table. VERIFIED in the browser.'), 'evidence',
    'evidence outranks a plain outcome');
  assert.equal(classify('REPRODUCED by adversarial review: the desk erased a committed write.'), 'finding');
  assert.equal(classify('DECIDED by Alberto: add optimistic concurrency.'), 'decision');
  assert.equal(classify('SHIPPED: GET returns an ETag.'), 'outcome');
});

test('an unmarked segment is a brief only when it opens the note', () => {
  assert.equal(classify('SPEC CAP-4. Split from SW-001 at the multi-goal check.', true), 'brief');
  assert.equal(classify('and then the rest of it happened', false), 'outcome',
    'an unlabelled addition is still work, not a brief');
});

test('markers are matched on a word boundary, not anywhere', () => {
  assert.equal(classify('the UNDONE work'), 'outcome', 'DONE. inside UNDONE must not match');
  assert.equal(classify('predecided by nobody'), 'outcome', 'DECIDED inside predecided must not match');
  assert.equal(classify('Decided to keep it'), 'decision', 'the caps convention is not enforced');
});

test('file paths are pulled out of prose and normalised', () => {
  const found = refs('Extracted into shipward/tracker-store.mjs; app.js and ./public/lib.js call it. '
    + 'See app.js. Not a match: version 1.0 or a bare sentence.');
  assert.deepEqual(found.sort(), ['app.js', 'public/lib.js', 'shipward/tracker-store.mjs']);
  assert.equal(found.filter((f) => f === 'app.js').length, 1, 'trailing punctuation is not a second file');
});

test('a note becomes one entry per appended segment', () => {
  const note = ['SPEC CAP-4. Split from SW-001.', 'SHIPPED: the table renders.', 'NEEDS ALBERTO: review it.']
    .join(SEGMENT_SEP);
  const entries = memoryEntries([card({ note })], 'shipward');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.kind), ['brief', 'outcome', 'open']);
  assert.deepEqual(entries.map((e) => e.id), ['SW-001#0', 'SW-001#1', 'SW-001#2']);
  assert.equal(entries[0].card, 'SW-001');
});

test('cards without notes and other projects contribute nothing', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: '' }),
    card({ id: 'SW-002', note: null }),
    card({ id: 'BW-001', p: 'brewnote', note: 'DECIDED: something' }),
  ], 'shipward');
  assert.deepEqual(entries, []);
});

test('entries are newest first by the best date the card has', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: 'oldest', created: '2026-07-01T00:00:00Z' }),
    card({ id: 'SW-002', note: 'newest', created: '2026-07-01T00:00:00Z', shipped: '2026-07-26T00:00:00Z' }),
    card({ id: 'SW-003', note: 'middle', created: '2026-07-01T00:00:00Z', pushed: '2026-07-10T00:00:00Z' }),
  ], 'shipward');
  assert.deepEqual(entries.map((e) => e.card), ['SW-002', 'SW-003', 'SW-001']);
});

test('grouping keeps the cost order and drops empty kinds', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: `brief here${SEGMENT_SEP}NEEDS ALBERTO: look` }),
    card({ id: 'SW-002', note: 'REPRODUCED: it broke' }),
  ], 'shipward');
  const groups = groupByKind(entries);
  assert.deepEqual(groups.map((g) => g.key), ['open', 'finding', 'brief'],
    'open leads, and kinds with nothing in them do not render');
});

test('the file index merges the same file written two different ways', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: 'Fixed shipward/serve.mjs' }),
    card({ id: 'SW-002', note: 'Also touched serve.mjs and app.css' }),
  ], 'shipward');
  const index = fileIndex(entries);
  assert.equal(index[0].file, 'serve.mjs');
  assert.equal(index[0].entries.length, 2, 'shipward/serve.mjs and serve.mjs are one file');
  assert.deepEqual(index[0].cards, ['SW-001', 'SW-002']);
  assert.equal(index[1].file, 'app.css');
});

test('search covers the prose, the id and the title', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', title: 'Archive view', note: 'the lock broke' }),
    card({ id: 'SW-002', title: 'Other', note: 'nothing to see' }),
  ], 'shipward');
  assert.equal(searchEntries(entries, 'lock').length, 1);
  assert.equal(searchEntries(entries, 'SW-002').length, 1);
  assert.equal(searchEntries(entries, 'archive').length, 1, 'case-insensitive on the title');
  assert.equal(searchEntries(entries, '   ').length, 2, 'a blank query filters nothing');
});

test('the lede counts what a session must know before anything else', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: `brief${SEGMENT_SEP}DECIDED: keep it${SEGMENT_SEP}NEEDS ALBERTO: check` }),
    card({ id: 'SW-002', note: 'REPRODUCED: lost a write' }),
  ], 'shipward');
  const lede = memoryLede(entries);
  assert.match(lede, /4 things Claude Code has written down/);
  assert.match(lede, /1 decision not to reverse/);
  assert.match(lede, /1 thing that bit us/);
  assert.match(lede, /1 still open/);
});

test('an open item answered later on the same card is not still open', () => {
  // Verbatim shape from SW-008: raised as a question, decided, then shipped.
  const note = [
    'REPRODUCED by adversarial review. NEEDS ALBERTO: either add optimistic concurrency, or narrow the Always.',
    'DECIDED by Alberto: add optimistic concurrency.',
    'SHIPPED: GET returns an ETag and PUT requires If-Match.',
  ].join(SEGMENT_SEP);
  const entries = memoryEntries([card({ note })], 'shipward');

  assert.equal(entries[0].kind, 'open', 'it was open when it was written');
  assert.equal(entries[0].superseded, true, 'and it is not open now');
  assert.equal(stillOpen(entries).length, 0, 'a fresh session must not re-ask an answered question');
  assert.match(memoryLede(entries), /0 still open/);
});

test('an open item with nothing after it stays open', () => {
  const note = ['SHIPPED: the thing.', 'LEFT STALE FOR ALBERTO: the SPEC still describes it.'].join(SEGMENT_SEP);
  const entries = memoryEntries([card({ note })], 'shipward');
  assert.equal(stillOpen(entries).length, 1, 'the last word on a card stands');
  assert.equal(stillOpen(entries)[0].superseded, false);
});

test('only open items can be superseded', () => {
  const note = ['REPRODUCED: it broke', 'FIXED: it does not any more'].join(SEGMENT_SEP);
  const [finding] = memoryEntries([card({ note })], 'shipward');
  assert.equal(finding.kind, 'finding');
  assert.equal(finding.superseded, false, 'a lesson learned is never obsolete');
});

test('superseded open items sink within their group rather than vanishing', () => {
  const settled = card({ id: 'SW-001', note: `NEEDS ALBERTO: pick one${SEGMENT_SEP}DECIDED: picked` });
  const live = card({ id: 'SW-002', note: 'NEEDS ALBERTO: still waiting', created: '2026-07-26T09:00:00Z' });
  const [group] = groupByKind(memoryEntries([settled, live], 'shipward'));
  assert.equal(group.key, 'open');
  assert.equal(group.entries.length, 2, 'both are shown — "this got answered here" is worth reading');
  assert.equal(group.entries[0].superseded, false, 'the live one leads');
  assert.equal(group.entries[1].superseded, true);
});
