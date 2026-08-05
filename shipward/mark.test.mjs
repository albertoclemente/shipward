// The standalone mark stays the colour the product is. Run: node --test
//
// SW-062. The mark is inlined in both headers with var(--color-text) and
// var(--color-accent), so it follows the token sheet through any restyle. The
// standalone asset cannot do that — a file has no stylesheet to read — so its
// two hex values are a third copy of the tokens.
//
// Duplication that is CHECKED is not drift. If a restyle moves a token, this
// fails and says to re-export, instead of leaving a logo quietly the wrong
// colour on every surface the repo does not render itself: the README image,
// the social card, whatever an app icon gets built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');

const tokenOf = (css, name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`, 'i'))?.[1]?.toLowerCase();
const fillsOf = (svg) => [...svg.matchAll(/<polygon[^>]*fill="([^"]+)"/g)].map((m) => m[1].toLowerCase());

test('the standalone mark uses exactly the token colours', async () => {
  const [svg, css] = await Promise.all([read('assets/shipward-mark.svg'), read('shipward/public/app.css')]);
  const text = tokenOf(css, 'color-text');
  const accent = tokenOf(css, 'color-accent');
  assert.ok(text && accent, 'the tokens must be readable from app.css for this check to mean anything');
  assert.deepEqual(fillsOf(svg), [text, accent],
    `assets/shipward-mark.svg is out of date: re-export it with hull ${text} and sail ${accent}`);
});

test('the favicon uses them too, inverted on the dark ground', async () => {
  const [svg, css] = await Promise.all([read('shipward/public/favicon.svg'), read('shipward/public/app.css')]);
  const fills = fillsOf(svg);
  // The favicon inverts the hull to --color-bg so it reads on a dark square;
  // only the sail is expected to match the accent.
  assert.equal(fills[1], tokenOf(css, 'color-accent'), 'the sail is the accent, here as everywhere');
  assert.equal(svg.match(/<rect[^>]*fill="([^"]+)"/)[1].toLowerCase(), tokenOf(css, 'color-text'),
    'and the ground is the text colour, so the icon is the wordmark inverted rather than a second palette');
});

test('the mark is the same shape wherever it is drawn', async () => {
  // Three copies of the geometry: the asset, the desk's ICON table and the
  // fleet's inline header. They are small enough that sharing them would cost
  // more than it saves — but not so small that a hand-edit to one cannot go
  // unnoticed, which is what this pins.
  const [asset, app, fleet] = await Promise.all([
    read('assets/shipward-mark.svg'), read('shipward/public/app.js'), read('shipward/fleet.mjs'),
  ]);
  const points = (s) => [...s.matchAll(/points="(2,20[^"]*|16,4[^"]*)"/g)].map((m) => m[1]);
  const expected = points(asset);
  assert.equal(expected.length, 2, 'hull and sail');
  assert.deepEqual(points(app), expected, 'the desk mark has drifted from the asset');
  assert.deepEqual(points(fleet), expected, 'the fleet mark has drifted from the asset');
});
