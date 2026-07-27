// Reading the memory back out of the tracker.
//
// A card's `note` is where the real value of this file accumulates — measured
// on the live tracker, notes are two thirds of it. It is free prose, and it
// stays free prose: Claude writes better memory in sentences than it would in
// a form, and the schema deliberately does not constrain it.
//
// But the prose grew a grammar anyway. With nothing asking for it, notes came
// out marked SHIPPED, VERIFIED, REPRODUCED, DECIDED, TRADEOFF, GOTCHA,
// NEEDS ALBERTO — 23 distinct kinds across twelve cards — and carrying file
// paths, commit shas and measurements inline.
//
// So this module reads that grammar rather than imposing one. Nothing here
// rewrites a note or writes to the tracker; every classification is a guess
// shown as a guess, and a segment that matches nothing is still rendered in
// full. The point is to surface what is already written, not to grade it.
import { cardsOf } from './lib.js';

// Claude appends to a note with " || ", so a note is already a series of
// entries laid down at different times.
export const SEGMENT_SEP = ' || ';

// Ordered by how much it would cost to miss. A segment carrying several
// markers takes the most expensive one: "SHIPPED … VERIFIED … LEFT STALE FOR
// ALBERTO" is, to the person reading, an open item.
export const KINDS = [
  {
    key: 'open',
    label: 'Still open',
    hint: 'waiting on a human, or knowingly left undone',
    markers: ['NEEDS ALBERTO', 'NOTE FOR ALBERTO', 'LEFT STALE', 'LEFT OPEN', 'OPEN =', 'OPEN:', 'TODO', 'UNRESOLVED', 'BLOCKED', '⚠️'],
  },
  {
    key: 'finding',
    label: 'What bit us',
    hint: 'bugs reproduced, root causes, gotchas worth not rediscovering',
    markers: ['REPRODUCED', 'ROOT CAUSE', 'BUG FOUND', 'FOUND WHILE', 'GOTCHA', 'LESSON', 'REGRESSION', 'FAILURE'],
  },
  {
    key: 'decision',
    label: 'Decisions & tradeoffs',
    hint: 'the choices a later session must not silently reverse',
    markers: ['DECIDED', 'DECISION', 'DESIGN CALL', 'RATIFIED', 'TRADEOFF', 'SCOPE NARROWED', 'SUPERSEDED', 'REJECTED', 'CHOSEN'],
  },
  {
    key: 'evidence',
    label: 'Evidence',
    hint: 'what was actually checked, and how',
    markers: ['VERIFIED', 'EVIDENCE', 'MEASURED', 'TESTS PASS', 'STRESS'],
  },
  {
    key: 'outcome',
    label: 'What shipped',
    hint: 'the work itself',
    markers: ['SHIPPED', 'FIXED', 'REMOVED', 'DONE.', 'IMPLEMENTED'],
  },
];

const BRIEF = { key: 'brief', label: 'Brief', hint: 'why the card exists', markers: [] };
export const ALL_KINDS = [...KINDS, BRIEF];

// Markers are written in caps by convention, but a note is prose and the
// convention is not enforced, so match case-insensitively on a word boundary.
function markerIndex(text, marker) {
  const hay = text.toUpperCase();
  const needle = marker.toUpperCase();
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const before = text[i - 1];
    if (before === undefined || !/[A-Za-z]/.test(before)) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

const matches = (text, marker) => markerIndex(text, marker) !== -1;

// Where the point of this entry starts. A note often opens with provenance
// ("Stage C of SW-005, depends on…") and reaches the decision three sentences
// later, so a clip taken from character zero shows the preamble and hides the
// thing worth reading.
export function pointIndex(text, kindKey) {
  const kind = KINDS.find((k) => k.key === kindKey);
  if (!kind) return 0;
  let best = -1;
  for (const m of kind.markers) {
    const i = markerIndex(text, m);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  if (best <= 0) return 0;
  // Back up to the start of that sentence so the clip does not begin mid-thought.
  const stop = Math.max(text.lastIndexOf('. ', best), text.lastIndexOf('? ', best), text.lastIndexOf('! ', best));
  return stop === -1 ? best : stop + 2;
}

// A clip that leads with the point, marked with a leading ellipsis when it
// starts partway in so the reader knows text was skipped rather than absent.
export function excerpt(entry, max = 240) {
  const from = pointIndex(entry.text, entry.kind);
  const body = entry.text.slice(from);
  const head = from > 0 ? '…' : '';
  if (head.length + body.length <= max) return head + body;
  return `${head}${body.slice(0, max - head.length - 1).trimEnd()}…`;
}

export function classify(text, isFirst = false) {
  for (const kind of KINDS) {
    if (kind.markers.some((m) => matches(text, m))) return kind.key;
  }
  // An unmarked opening segment is the brief the card was logged with; an
  // unmarked later one is an unlabelled addition, which is still work.
  return isFirst ? 'brief' : 'outcome';
}

export const kindOf = (key) => ALL_KINDS.find((k) => k.key === key) || BRIEF;

// Openness is a property of the card's latest state, not of the segment that
// first raised it. SW-008's note opens "NEEDS ALBERTO: either add optimistic
// concurrency or narrow the Always", and two segments later says "DECIDED by
// Alberto" and "SHIPPED" — reading that as an open question would send a fresh
// session to re-ask a question already answered on the same card.
const RESOLUTION = ['DECIDED', 'RESOLVED', 'ANSWERED', 'RATIFIED', 'SHIPPED', 'FIXED', 'REMOVED', 'REWORKED', 'DONE.'];

export const resolves = (text) => RESOLUTION.some((m) => matches(text, m));

// Paths as they appear in prose. Requiring a known source extension keeps
// ordinary sentences from turning into false links; the trailing punctuation
// strip stops "app.js." and "app.js" being two different files.
const PATH_RE = /\b[\w./-]+\.(?:mjs|js|json|css|html|md)\b/g;

export function refs(text) {
  const seen = new Set();
  for (const raw of text.match(PATH_RE) || []) {
    const path = raw.replace(/^[./]+/, '').replace(/[.,;:]+$/, '');
    if (path) seen.add(path);
  }
  return [...seen];
}

// Function names as they appear in prose. This matters more than it looks: the
// single most valuable note in this repo — the one about live locks being
// broken — names no file at all. It talks about isStale(), breakLock() and
// sweepTmp(), because that is how you naturally write down what went wrong.
// Indexing only paths made that note unreachable from the file it is about.
const SYMBOL_RE = /\b([A-Za-z_$][\w$]*)\(\)/g;

export function symbols(text) {
  const seen = new Set();
  for (const [, name] of text.matchAll(SYMBOL_RE)) seen.add(name);
  return [...seen];
}

const namesIn = (entry) => [
  ...entry.syms.map((s) => s.toLowerCase()),
  ...entry.refs.map((r) => r.toLowerCase().split('/').pop()),
];

const hits = (entry, token) => {
  const names = namesIn(entry);
  return names.includes(token) || names.some((n) => n.includes(token) && n.endsWith(token));
};

// True if the entry names any of these tokens — a file, a function, whatever
// the caller knows the code by.
export function mentionsAny(entry, tokens) {
  const want = tokens.map((t) => String(t).toLowerCase()).filter(Boolean);
  return want.some((t) => hits(entry, t));
}

// A file declares dozens of names and most of them are generic — now(), read(),
// line() — so matching on any of them returns the whole tracker. A token that
// appears across most of the memory carries no information about which entries
// are relevant, so it is dropped before scoring. Crude inverse document
// frequency, and it is the difference between recall being useful and being
// noise a session learns to skip.
const GENERIC_SHARE = 0.25;
// A share means nothing on a young repo: with four entries, a token in one of
// them is already 25%. Nothing is called generic until it has actually turned
// up several times — otherwise the filter eats every token and recall returns
// nothing at all, which is exactly what it did the first time it ran.
const GENERIC_MIN_HITS = 4;

export function distinctiveTokens(entries, tokens, keep = []) {
  if (!entries.length) return tokens;
  const always = new Set(keep.map((t) => String(t).toLowerCase()));
  return tokens
    .map((t) => String(t).toLowerCase())
    .filter(Boolean)
    .filter((t) => {
      if (always.has(t)) return true;
      const count = entries.filter((e) => hits(e, t)).length;
      if (!count) return false;
      return !(count >= GENERIC_MIN_HITS && count / entries.length > GENERIC_SHARE);
    });
}

// How many distinct tokens an entry names. More matches is stronger evidence
// that the entry is really about this code rather than mentioning it in passing.
export const tokenScore = (entry, tokens) => tokens.filter((t) => hits(entry, t)).length;

// One entry per note segment, newest card first. `at` is the best timestamp the
// card can offer — a segment is not individually dated, and inventing a date
// would be worse than admitting the note only knows the card's own clock.
export function memoryEntries(cards, projectId) {
  const out = [];
  for (const card of cardsOf(cards, projectId)) {
    if (!card.note) continue;
    const segments = card.note.split(SEGMENT_SEP).map((s) => s.trim()).filter(Boolean);
    segments.forEach((text, i) => {
      const kind = classify(text, i === 0);
      out.push({
        id: `${card.id}#${i}`,
        card: card.id,
        title: card.title,
        status: card.status,
        commit: card.commit,
        branch: card.branch,
        at: card.shipped || card.pushed || card.created,
        kind,
        // Only an open item can be settled, and only by something written after
        // it on the same card.
        superseded: kind === 'open' && segments.slice(i + 1).some(resolves),
        text,
        refs: refs(text),
        syms: symbols(text),
      });
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// The live open items: what is genuinely still waiting, superseded ones removed.
export const stillOpen = (entries) => entries.filter((e) => e.kind === 'open' && !e.superseded);

// Superseded open items sort to the bottom of their group rather than
// disappearing: "this was open and got answered here" is itself worth reading.
export function groupByKind(entries) {
  return ALL_KINDS
    .map((kind) => ({
      ...kind,
      entries: entries
        .filter((e) => e.kind === kind.key)
        .sort((a, b) => Number(a.superseded || false) - Number(b.superseded || false)),
    }))
    .filter((g) => g.entries.length);
}

// Which files this repo has accumulated knowledge about, busiest first. This is
// the query a session actually arrives with: "what do we know about the thing I
// am about to touch?"
export function fileIndex(entries) {
  const byPath = new Map();
  for (const e of entries) {
    for (const path of e.refs) {
      // Index on the basename: the same file is written both as
      // "shipward/serve.mjs" and "serve.mjs" in the notes, and they are one file.
      const name = path.split('/').pop();
      if (!byPath.has(name)) byPath.set(name, { file: name, entries: [], cards: new Set() });
      const rec = byPath.get(name);
      rec.entries.push(e);
      rec.cards.add(e.card);
    }
  }
  return [...byPath.values()]
    .map((r) => ({ ...r, cards: [...r.cards] }))
    .sort((a, b) => b.entries.length - a.entries.length || a.file.localeCompare(b.file));
}

// Does this entry's prose mention that file? Basenames, because the notes write
// the same file as "shipward/serve.mjs" and "serve.mjs"; a substring match on
// top so "tracker-store" finds "tracker-store.mjs" without the extension.
export function mentionsFile(entry, file) {
  const want = file.trim().toLowerCase().split('/').pop();
  if (!want) return false;
  return entry.refs.some((r) => {
    const name = r.toLowerCase().split('/').pop();
    return name === want || name.includes(want);
  });
}

// Retrieval, as opposed to display. The caller is a session about to do
// something, so results are ranked by what it would cost to miss rather than by
// date, and `dropped` is always reported — a silent truncation reads as "that
// is everything" when it is not.
export function recall(entries, { file, kind, query, tokens, limit = 10 } = {}) {
  let out = entries;

  // `tokens` is the caller saying "here is everything this code is known by" —
  // the filename plus the names declared inside it. Matching on the filename
  // alone missed notes that only ever named the functions.
  let useful = [];
  if (tokens?.length) {
    // The filename is always kept: it is the most specific thing we were given.
    useful = distinctiveTokens(entries, tokens, file ? [file.split('/').pop()] : []);
    out = out.filter((e) => mentionsAny(e, useful));
  } else if (file) {
    out = out.filter((e) => mentionsFile(e, file));
  }
  if (kind) out = out.filter((e) => e.kind === kind);
  if (query) out = searchEntries(out, query);
  // Superseded open items are history, not something to act on.
  out = out.filter((e) => !e.superseded);

  const rank = (e) => ALL_KINDS.findIndex((k) => k.key === e.kind);
  const ranked = out.slice().sort((a, b) =>
    // For a code query, relevance leads: an entry naming four of this file's
    // functions is about it; one naming a single generic helper is not.
    (useful.length ? tokenScore(b, useful) - tokenScore(a, useful) : 0)
    || rank(a) - rank(b)
    || Date.parse(b.at) - Date.parse(a.at));

  return {
    total: ranked.length,
    dropped: Math.max(0, ranked.length - limit),
    matchedOn: useful,
    entries: ranked.slice(0, limit),
  };
}

export function searchEntries(entries, query) {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    e.text.toLowerCase().includes(q)
    || e.card.toLowerCase().includes(q)
    || e.title.toLowerCase().includes(q));
}

// The one line a session should read before anything else.
export function memoryLede(entries) {
  const open = stillOpen(entries).length;
  const findings = entries.filter((e) => e.kind === 'finding').length;
  const decisions = entries.filter((e) => e.kind === 'decision').length;
  const words = entries.reduce((n, e) => n + e.text.split(/\s+/).length, 0);
  return `${entries.length} things Claude Code has written down here — about ${words.toLocaleString('en-US')} words. `
    + `${decisions} decision${decisions === 1 ? '' : 's'} not to reverse, ${findings} thing${findings === 1 ? '' : 's'} that bit us, `
    + `${open} still open.`;
}
