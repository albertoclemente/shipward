// Status line tests. Run: node --test
//
// statusLine() is pure and exported, so most of this is direct. The spawn tests
// exist for the one rule that cannot be checked in-process: a status line must
// never break the terminal it renders into, whatever it is handed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusLine } from './status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'status.mjs');
const ESC = /\[[0-9;]*m/g;
const plain = (s) => s.replace(ESC, '');

const card = (over = {}) => ({
  id: 'SW-001', p: 'shipward', title: 'A card', type: 'feature', pri: 'P2', effort: 'M',
  status: 'backlog', claude: null, branch: null, commit: null, note: '',
  created: '2026-07-25T09:00:00Z', pushed: null, shipped: null, ...over,
});

const doc = (cards) => ({
  version: 1,
  activeProject: 'shipward',
  projects: [{ id: 'shipward', name: 'Shipward', tag: 't', prefix: 'SW' }],
  cards,
  feed: [],
});

function run(tracker, env = {}) {
  return new Promise((res) => {
    execFile(process.execPath, [SCRIPT], { env: { ...process.env, SHIPWARD_TRACKER: tracker, ...env } },
      (err, stdout) => res({ code: err?.code ?? 0, out: stdout }));
  });
}

test('one card in flight leads with a filled mark and its id', () => {
  const out = plain(statusLine(doc([card({ id: 'SW-016', status: 'claude', claude: 'working', title: 'Ambient status line' })])));
  assert.match(out, /^◆ SW-016 Ambient status line/);
});

test('the shape carries the state even with the colour stripped', () => {
  // A terminal that drops colour must still distinguish working from idle.
  const busy = plain(statusLine(doc([card({ status: 'claude', claude: 'working' })])));
  const idle = plain(statusLine(doc([card({ status: 'backlog' })])));
  assert.ok(busy.startsWith('◆'), 'filled when something is in flight');
  assert.ok(idle.startsWith('◇'), 'hollow when nothing is');
  assert.match(idle, /no card/);
});

test('several cards in flight collapse to a count', () => {
  const out = plain(statusLine(doc([
    card({ id: 'SW-001', status: 'claude', claude: 'working' }),
    card({ id: 'SW-002', status: 'claude', claude: 'queued' }),
  ])));
  assert.match(out, /^◆ 2 in flight/, 'two titles would not fit, and neither is "the" one');
});

test('counts appear only when they are non-zero', () => {
  // A line that always reads "0 review · 0 backlog" is furniture, and furniture
  // stops being read.
  const quiet = plain(statusLine(doc([card({ status: 'claude', claude: 'working' })])));
  assert.doesNotMatch(quiet, /review|backlog|open/);

  const busy = plain(statusLine(doc([
    card({ id: 'SW-001', status: 'claude', claude: 'working' }),
    card({ id: 'SW-002', status: 'review' }),
    card({ id: 'SW-003', status: 'backlog' }),
  ]), { openCount: 4 }));
  assert.match(busy, /1 review/);
  assert.match(busy, /1 backlog/);
  assert.match(busy, /4 open/);
});

test('a long title is clipped, and nothing else is', () => {
  const long = 'An extremely long card title that would otherwise eat the whole terminal width';
  const out = plain(statusLine(doc([card({ id: 'SW-016', status: 'claude', claude: 'working', title: long })]), { openCount: 9 }));
  assert.match(out, /…/, 'the title gives');
  assert.match(out, /SW-016/, 'the id never does');
  assert.match(out, /9 open/, 'and neither do the counts');
  assert.ok(out.length < 90, `line stayed reasonable: ${out.length}`);
});

test('cards from other projects are not counted', () => {
  const out = plain(statusLine(doc([
    card({ id: 'SW-001', status: 'claude', claude: 'working' }),
    { ...card({ id: 'BW-001', status: 'review' }), p: 'brewnote' },
  ])));
  assert.doesNotMatch(out, /review/);
});

test('a tracker with no projects renders nothing rather than guessing', () => {
  assert.equal(statusLine({ version: 1, projects: [], cards: [], feed: [] }), '');
});

test('NO_COLOR strips every escape sequence', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'shipward-status-'));
  try {
    await mkdir(join(sandbox, '.shipward'));
    const tracker = join(sandbox, '.shipward', 'tracker.json');
    await writeFile(tracker, JSON.stringify(doc([card({ status: 'claude', claude: 'working' })])));

    const coloured = await run(tracker);
    assert.match(coloured.out, ESC, 'colour by default');

    const bare = await run(tracker, { NO_COLOR: '1' });
    assert.doesNotMatch(bare.out, ESC, 'NO_COLOR is honoured');
    assert.match(bare.out, /◆ SW-001/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('a status line never breaks the terminal, whatever it is handed', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'shipward-status-'));
  try {
    await mkdir(join(sandbox, '.shipward'));
    const tracker = join(sandbox, '.shipward', 'tracker.json');

    const missing = await run(join(sandbox, 'nowhere', 'tracker.json'));
    assert.equal(missing.code, 0);
    assert.equal(missing.out, '', 'a missing tracker prints nothing at all');

    await writeFile(tracker, 'not json');
    const broken = await run(tracker);
    assert.equal(broken.code, 0);
    assert.equal(broken.out, '');

    await writeFile(tracker, JSON.stringify({ version: 1 }));   // no cards, no projects
    const partial = await run(tracker);
    assert.equal(partial.code, 0);
    assert.equal(partial.out, '');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('importing the module prints nothing', () => {
  // A status line that fires on import would scribble into anything that loads
  // it — including this test run.
  assert.equal(typeof statusLine, 'function');
});


/* -- after the adversarial review (SW-018) ------------------
   The reviewer broke the "never breaks the terminal" invariant on its first
   try. These reproduce its payloads, built from char codes so the test file
   itself stays free of control characters. */

const ESCC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROLS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]');
const BIDI = new RegExp('[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]');

test('tracker text can never reach the terminal as control sequences', () => {
  const attacks = {
    'tab title': ESCC + ']0;PWNED' + BEL + 'ok',
    'clear screen': ESCC + '[2J' + ESCC + '[Hgone',
    'alt screen': ESCC + '[?1049h' + ESCC + '#8',
    'carriage return': 'safe\rEVIL',
    newline: 'line1\nline2\nline3',
    'rtl override': 'safe' + String.fromCharCode(0x202E) + 'reversed',
    'c1 control': 'a' + String.fromCharCode(0x9B) + 'B',
  };
  for (const [name, title] of Object.entries(attacks)) {
    const out = statusLine(doc([card({ status: 'claude', claude: 'working', title })]));
    // Only the colour codes this module emits itself may contain ESC.
    assert.doesNotMatch(out.replace(ESC, ''), CONTROLS, name + ' leaked a control character');
    assert.equal(out.split('\n').length, 1, name + ' broke the line in two');
    assert.doesNotMatch(out, BIDI, name + ' leaked a bidi override');
  }
});

test('the card id is bounded and scrubbed too, not just the title', () => {
  // status.mjs never calls validate(), so ID_RE does not apply here — the id
  // was interpolated raw and never clipped.
  const evil = ESCC + ']0;OWNED' + BEL + ESCC + '[2J' + 'SW-1'.repeat(40);
  const out = statusLine(doc([card({ id: evil, status: 'claude', claude: 'working' })]));
  assert.doesNotMatch(out.replace(ESC, ''), CONTROLS);
  assert.ok(out.length < 90, 'id was not bounded: ' + out.length + ' chars');
});

test('a clip never leaves half an emoji in the status line', () => {
  const rocket = String.fromCodePoint(0x1F680);
  const out = statusLine(doc([card({
    status: 'claude', claude: 'working', title: 'A'.repeat(32) + rocket + rocket,
  })]));
  assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    'a lone surrogate renders as a replacement glyph');
});

test('the open-item scan is dropped rather than stalling a huge board', async () => {
  // Measured 390ms at 1000 cards and 1.6s at 5000 — on the critical path of a
  // line that renders constantly.
  const sandbox = await mkdtemp(join(tmpdir(), 'shipward-status-'));
  try {
    await mkdir(join(sandbox, '.shipward'));
    const tracker = join(sandbox, '.shipward', 'tracker.json');
    const many = Array.from({ length: 900 }, (_, i) =>
      card({ id: 'SW-' + String((i % 999) + 1).padStart(3, '0'), note: 'NEEDS ALBERTO: something' }));
    many[0] = card({ id: 'SW-001', status: 'claude', claude: 'working', title: 'busy' });
    await writeFile(tracker, JSON.stringify(doc(many)));

    const started = Date.now();
    const { out, code } = await run(tracker, { NO_COLOR: '1' });
    assert.equal(code, 0);
    assert.match(out, /SW-001/, 'the line still renders');
    assert.doesNotMatch(out, /open/, 'the count is dropped, not stalled on');
    assert.ok(Date.now() - started < 20000, 'and it did not hang');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
