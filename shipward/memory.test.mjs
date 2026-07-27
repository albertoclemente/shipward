// Memory view logic. Run: node --test
//
// The classifier reads prose Claude wrote freely, so these tests use the real
// shapes that appear in the live tracker rather than tidy invented ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, refs, symbols, mentionsAny, distinctiveTokens, recall, excerpt,
  memoryEntries, groupByKind, fileIndex, searchEntries, memoryLede, stillOpen, SEGMENT_SEP,
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

test('symbols are pulled out of prose alongside file paths', () => {
  const text = 'isStale() judged the lock from two observations; breakLock() then renamed it. See sweepTmp().';
  assert.deepEqual(symbols(text).sort(), ['breakLock', 'isStale', 'sweepTmp']);
  assert.deepEqual(refs(text), [], 'this note names no files at all — which is the point');
});

test('an entry is reachable by the functions it names, not only by filename', () => {
  // Verbatim problem from SW-010: the most valuable note in the repo names no
  // file, so indexing paths alone made it unreachable from the file it is about.
  const [entry] = memoryEntries([card({ note: 'ROOT CAUSE: isStale() read stat and content separately.' })], 'shipward');
  assert.equal(mentionsAny(entry, ['tracker-store.mjs']), false, 'the note never says the filename');
  assert.equal(mentionsAny(entry, ['isStale']), true, 'but it does say the function');
});

test('generic names are dropped before scoring, the filename never is', () => {
  // A file declares dozens of names; now() appears everywhere and says nothing
  // about which entries are relevant.
  // now() has to have turned up at least GENERIC_MIN_HITS times before the
  // frequency filter is allowed to call it generic.
  const entries = memoryEntries([
    card({ id: 'SW-001', note: 'used now() here' }),
    card({ id: 'SW-002', note: 'also now() here' }),
    card({ id: 'SW-003', note: 'now() again' }),
    card({ id: 'SW-004', note: 'and now() once more' }),
    card({ id: 'SW-005', note: 'ROOT CAUSE: isStale() and breakLock() disagreed' }),
  ], 'shipward');

  const kept = distinctiveTokens(entries, ['now', 'isStale', 'breakLock', 'tracker-store.mjs'], ['tracker-store.mjs']);
  assert.equal(kept.includes('now'), false, 'a token in most entries carries no information');
  assert.ok(kept.includes('isstale') && kept.includes('breaklock'));
  assert.ok(kept.includes('tracker-store.mjs'), 'the filename is kept even though nothing matches it');
});

test('recall ranks an entry naming several of a file\'s functions above one naming a helper', () => {
  const entries = memoryEntries([
    card({ id: 'SW-001', note: 'in passing we called inspect()' }),
    card({ id: 'SW-002', note: 'ROOT CAUSE: isStale(), breakLock() and sweepTmp() disagreed', created: '2026-07-20T00:00:00Z' }),
  ], 'shipward');
  const hit = recall(entries, { tokens: ['isStale', 'breakLock', 'sweepTmp', 'inspect'], limit: 5 });
  assert.equal(hit.entries[0].card, 'SW-002', 'three matches beat one, and beat being newer');
  assert.equal(hit.total, 2);
});

test('recall hides superseded items and reports what it dropped', () => {
  const settled = card({ id: 'SW-001', note: `NEEDS ALBERTO: pick one${SEGMENT_SEP}DECIDED: picked` });
  const many = Array.from({ length: 5 }, (_, i) =>
    card({ id: `SW-10${i}`, note: `REPRODUCED: failure ${i}` }));
  const entries = memoryEntries([settled, ...many], 'shipward');

  assert.equal(recall(entries, { kind: 'open' }).total, 0, 'an answered question is not recalled as open');
  const hit = recall(entries, { kind: 'finding', limit: 2 });
  assert.equal(hit.entries.length, 2);
  assert.equal(hit.total, 5);
  assert.equal(hit.dropped, 3, 'a silent truncation would read as "that is everything"');
});

test('the excerpt leads with the point, not the preamble', () => {
  const [e] = memoryEntries([card({
    note: 'Stage C of SW-005, depends on stage B. Rewrite the docs. KNOWN TRADEOFF: the heartbeat dirties git every minute.',
  })], 'shipward');
  const out = excerpt(e, 200);
  assert.match(out, /^…KNOWN TRADEOFF/, 'starts at the marker, and says text was skipped');
  assert.doesNotMatch(out, /Stage C/);
});

test('an excerpt that starts at the beginning carries no ellipsis', () => {
  const [e] = memoryEntries([card({ note: 'DECIDED: keep it simple.' })], 'shipward');
  assert.equal(excerpt(e, 200), 'DECIDED: keep it simple.');
});

test('on a young repo nothing is generic yet', () => {
  // REGRESSION: the frequency filter used share alone, so with two entries a
  // token appearing in one was 50% and got dropped as "generic" — every token
  // was eaten and recall returned nothing at all.
  const entries = memoryEntries([
    card({ id: 'SW-001', note: 'ROOT CAUSE: isStale() misjudged it' }),
    card({ id: 'SW-002', note: 'unrelated work' }),
  ], 'shipward');
  assert.deepEqual(distinctiveTokens(entries, ['isStale']), ['isstale']);
  assert.equal(recall(entries, { tokens: ['isStale'] }).total, 1);
});
