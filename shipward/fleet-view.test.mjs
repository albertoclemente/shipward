// What a fleet row says. Run: node --test
//
// SW-047. These are the decisions that used to live inside a template literal,
// where nothing could reach them. Two silent outages came out of that string —
// SW-036 (an escaping slip killed the whole script) and SW-038 (a validator
// written as a snapshot unlinked every board) — and both are the kind of thing
// a pure function makes impossible to ship unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deskHref, boardView, candidateView, rowView, fleetLede, onboardPrompt,
} from './public/fleet-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const board = (over = {}) => ({
  kind: 'board', ok: true, name: 'Shipward', folder: 'shipward_app', prefix: 'SW',
  desk: 'http://localhost:4747/', working: 1, review: 2, backlog: 3, pushed: 4,
  deskError: null, last: null, ...over,
});

/* ── the validator that unlinked the fleet ───────────────── */

test('a plain local desk href is a link', () => {
  assert.equal(deskHref('http://localhost:4747/'), 'http://localhost:4747/');
  assert.equal(deskHref('http://127.0.0.1:9/'), 'http://127.0.0.1:9/');
});

test('a query parameter does not unlink the board — SW-038, exactly', () => {
  // The producer grew ?fleet=; the consumer's regex did not. Ten rows lost
  // their anchors and nothing reported it. This asserts the property rather
  // than the spelling, so the NEXT parameter cannot repeat it.
  for (const href of [
    'http://localhost:4747/?fleet=http://localhost:4740',
    'http://localhost:4747/?a=1&b=2',
    'http://localhost:4747/#anchor',
  ]) {
    assert.equal(deskHref(href), href, `${href} must stay a link`);
  }
});

test('anything that is not a local desk root is refused', () => {
  for (const href of [
    'javascript:alert(1)',
    'https://evil.com/',
    'http://localhost.evil.com/',
    'http://example.com:4747/',
    'http://localhost:4747/some/path',
    'file:///etc/passwd',
    '', null, undefined, 42, {},
  ]) {
    assert.equal(deskHref(href), null, `${JSON.stringify(href)} must not be rendered as a link`);
  }
});

/* ── rows ────────────────────────────────────────────────── */

test('a healthy board carries its link, prefix and split stats', () => {
  const v = boardView(board());
  assert.equal(v.href, 'http://localhost:4747/');
  assert.equal(v.nameClass, 'name');
  assert.equal(v.prefix, 'SW-… · shipward_app');
  assert.deepEqual(v.stats, { working: '1', review: '2', tail: '3 backlog · 4 pushed' });
});

test('a live board whose desk cannot be linked is dimmed, not broken', () => {
  const v = boardView(board({ desk: null }));
  assert.equal(v.href, null);
  assert.equal(v.nameClass, 'name dead');
  assert.equal(v.rowClass, 'row', 'the board itself is fine — only its desk is unreachable');
  assert.ok(v.stats, 'and its counts still render');
});

test('an unreadable board carries its error and no stats at all', () => {
  const v = boardView(board({ ok: false, error: 'tracker unreadable — EACCES' }));
  assert.equal(v.rowClass, 'row dead');
  assert.match(v.error, /EACCES/);
  assert.equal(v.stats, null);
  assert.equal(v.prefix, null);
  assert.equal(v.href, null, 'a board that cannot be read must never be clickable');
});

test('a desk error on a readable board is reported beside the counts', () => {
  const v = boardView(board({ deskError: 'desk exited 1' }));
  assert.equal(v.deskError, 'desk exited 1');
  assert.ok(v.stats);
});

test('the last feed line is split so the author can be emphasised', () => {
  const v = boardView(board({ last: { by: 'claude', msg: 'SW-047 moved to Review', ago: '2m ago' } }));
  assert.deepEqual(v.last, { by: 'claude', text: 'SW-047 moved to Review · 2m ago' });
});

test('a candidate offers itself without pretending to be a board', () => {
  const v = candidateView({ kind: 'candidate', name: 'catch', folder: 'catch_grocery_app', repo: '/x/catch' });
  assert.equal(v.kind, 'candidate');
  assert.match(v.tagline, /not on Shipward yet/);
  assert.equal(v.repo, '/x/catch');
});

test('rowView dispatches on kind', () => {
  assert.equal(rowView({ kind: 'candidate', name: 'a', folder: 'a', repo: '/a' }).kind, 'candidate');
  assert.equal(rowView(board()).kind, 'board');
});

/* ── the lede ────────────────────────────────────────────── */

test('the lede counts boards and candidates as the different things they are', () => {
  const text = fleetLede([
    board({ working: 1, review: 0 }),
    board({ working: 0, review: 0 }),
    { kind: 'candidate' },
  ]);
  assert.match(text, /2 boards — 1 with something in flight/);
  assert.match(text, /1 repo not onboarded yet/);
});

test('one board is not "1 boards"', () => {
  assert.match(fleetLede([board()]), /^1 board — /);
});

test('no candidates means no mention of them', () => {
  assert.doesNotMatch(fleetLede([board()]), /onboarded/);
});

test('an empty root explains itself instead of saying zero', () => {
  assert.match(fleetLede([]), /No \.shipward\/tracker\.json/);
});

/* ── the escaping hazard, gone ───────────────────────────── */

test('the onboard prompt has real newlines, because it is no longer inside a literal', () => {
  // In the PAGE template this had to be written \\n, escaped once for the outer
  // string. Getting that wrong turned a string literal into two lines of broken
  // source and killed the entire script — SW-036, which no test could see.
  const text = onboardPrompt('catch');
  assert.ok(text.includes('\n\n'), 'a real blank line, not a backslash-n');
  assert.match(text, /^Wire catch to Shipward\?/);
  assert.match(text, /reversible/);
});

test('the served page carries no inline script left to mis-escape', async () => {
  const src = await readFile(join(HERE, 'fleet.mjs'), 'utf8');
  const page = src.slice(src.indexOf('const PAGE'), src.indexOf('/* ── server'));
  assert.doesNotMatch(page, /<script>/, 'the page must load a module, not embed one');
  assert.match(page, /<script type="module" src="\/fleet-client\.js">/);
});

test('the browser module is real source: it imports, and importing it starts nothing', async () => {
  // The whole point of the move — a template literal could never be imported or
  // even parsed by `node --check`; this is just a file.
  //
  // It also must not START on import. The first version of this called
  // setInterval at module scope, so importing it here held the event loop open
  // and node --test ran until it was killed: a hang, which reads like an
  // infrastructure problem rather than a bug. Bootstrapping is now guarded on
  // `document`, which a browser has and this does not.
  const mod = await import('./public/fleet-client.js');
  assert.equal(typeof mod.refresh, 'function');
  assert.equal(typeof mod.start, 'function');
});
