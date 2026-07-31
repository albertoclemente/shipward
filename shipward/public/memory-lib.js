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

// SW-028, ratified by Alberto 2026-07-28: a note may also be an ARRAY of
// entries — { t, text, kind?, resolves? } — instead of prose around an
// unescaped delimiter. Everything below reads both. The three limits SW-013
// documented all die with the structured form: an explicit `kind` cannot be
// fooled by a note that merely QUOTES a marker word, an entry has no separator
// to collide with, and `resolves` names the CARD whose open items this entry
// settles — the cross-card link prose could never carry.
//
// String notes stay valid forever: CLAUDE.md documents hand-editing the tracker
// as supported, and the classifier remains the fallback wherever a kind is not
// stated.
const VALID_KIND = (k) => ALL_KINDS.some((x) => x.key === k);

// A card's note as raw segments, whichever form it is in. `kind`/`t`/`resolves`
// are present only when the note actually stored them.
export function noteSegments(note) {
  if (Array.isArray(note)) {
    return note
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .map((e) => ({
        text: e.text.trim(),
        kind: VALID_KIND(e.kind) ? e.kind : undefined,
        t: typeof e.t === 'string' ? e.t : undefined,
        resolves: typeof e.resolves === 'string' ? e.resolves : undefined,
      }));
  }
  if (typeof note !== 'string' || !note) return [];
  return note.split(SEGMENT_SEP).map((s) => s.trim()).filter(Boolean).map((text) => ({ text }));
}

// Append one entry to a note, whichever form it is in today. The single shared
// implementation — MCP, the reconciler and the desk all append through this,
// because two versions of "convert legacy prose, then push" would eventually
// convert differently. A prose note converts on first structured append: its
// segments become entries stamped with the card's own clock, which is exactly
// the date the reader would have guessed for them anyway.
export function appendedNote(note, createdFallback, entry) {
  const prior = Array.isArray(note)
    ? note.slice()
    : noteSegments(note).map((s) => ({ t: createdFallback, text: s.text }));
  return [...prior, entry];
}

// Render a note back as text — for the MCP `start` handoff and anywhere else a
// human-or-model reads the whole thing in one piece. A string note passes
// through untouched.
export function noteText(note) {
  if (typeof note === 'string') return note;
  return noteSegments(note)
    .map((s) => {
      const stamp = [s.t ? s.t.slice(0, 10) : '', s.kind || ''].filter(Boolean).join(' · ');
      const head = stamp ? `[${stamp}${s.resolves ? ` · resolves ${s.resolves}` : ''}] ` : '';
      return head + s.text;
    })
    .join('\n\n');
}

// The bounded form of noteText, for the one caller that renders a whole note
// into a model's context: the MCP `start` handoff (SW-040).
//
// noteText has no ceiling, and a note only ever grows — measured 2026-07-31,
// the biggest live notes were CA-011 at 6,187 chars and CA-013 at 5,511, and
// start() sits on the mandatory protocol path, so every task paid for the whole
// history of its card.
//
// The split is by age rather than by a flat clip, because the two halves of a
// note are not worth the same to a session about to work the card: the most
// recent entries are the state it is resuming, and the older ones are context
// it mostly needs to know EXISTS. So the newest `full` entries render exactly
// as noteText renders them today, and everything older is clipped to its point
// by excerpt(). `clipped` is returned rather than swallowed — the caller has to
// say so, for the same reason recall reports its dropped count.
export function noteDigest(note, { full = 3, max = 400 } = {}) {
  const segs = noteSegments(note);
  let clipped = 0;
  // Notes are appended, so the array runs oldest to newest and the tail is what
  // survives whole. Chronological order is preserved either way: a note read
  // out of order is a different note.
  const keepFrom = Math.max(0, segs.length - Math.max(0, full));
  const text = segs.map((seg, i) => {
    const stamp = [seg.t ? seg.t.slice(0, 10) : '', seg.kind || ''].filter(Boolean).join(' · ');
    const head = stamp ? `[${stamp}${seg.resolves ? ` · resolves ${seg.resolves}` : ''}] ` : '';
    if (i >= keepFrom) return head + seg.text;
    // Compared against the UNCLIPPED excerpt, not against seg.text: excerpt
    // also repositions to the point and prepends an ellipsis, so an entry that
    // merely moved would otherwise be miscounted as one that lost content.
    const whole = excerpt(seg, Infinity);
    const short = excerpt(seg, max);
    if (short !== whole) clipped++;
    return head + short;
  }).join('\n\n');
  return { text, clipped, entries: segs.length };
}

// Ordered by how much it would cost to miss. A segment carrying several
// markers takes the most expensive one: "SHIPPED … VERIFIED … LEFT STALE FOR
// ALBERTO" is, to the person reading, an open item.
export const KINDS = [
  {
    key: 'open',
    label: 'Still open',
    hint: 'waiting on a human, or knowingly left undone',
    markers: ['NEEDS ALBERTO', 'NOTE FOR ALBERTO', 'LEFT STALE', 'LEFT OPEN', 'OPEN =', 'OPEN:', 'TODO', 'UNRESOLVED', 'BLOCKED', '\u26A0'],
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
// convention is not enforced, so matching is case-insensitive.
//
// The search runs over the ORIGINAL text via a case-insensitive regex rather
// than over an uppercased copy. An uppercased copy is not the same length —
// "ß" becomes "SS", "ﬁ" becomes "FI" — so indexes into it drift out of step
// with the real string, and the boundary check then read the wrong character.
// One German word ahead of a marker was enough to file an open item under
// "What shipped".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_RE = new Map();
const markerRe = (marker) => {
  let re = MARKER_RE.get(marker);
  if (!re) { re = new RegExp(escapeRe(marker), 'gi'); MARKER_RE.set(marker, re); }
  re.lastIndex = 0;
  return re;
};

// A marker has to stand as its own word. Glued to letters it is another word;
// glued through "/", "-" or a dotted extension it is part of a URL or a
// filename. A link to a repo called "todo-list", or a note renaming "todo.js",
// was being read as an open item and pinned to the standup forever.
const LETTER = /[A-Za-z]/;
function standsAlone(text, i, len) {
  const before = text[i - 1];
  if (before !== undefined && (LETTER.test(before) || before === '/' || before === '-' || before === '.')) return false;
  const after = text[i + len];
  if (after === undefined) return true;
  if (LETTER.test(after) || after === '/' || after === '-') return false;
  // "VERIFIED." ends a sentence and still counts; "todo.js" does not.
  if (after === '.' && /\w/.test(text[i + len + 1] || '')) return false;
  return true;
}

function markerIndex(text, marker) {
  if (typeof text !== 'string') return -1;
  const re = markerRe(marker);
  let m;
  while ((m = re.exec(text))) {
    if (standsAlone(text, m.index, m[0].length)) return m.index;
    re.lastIndex = m.index + 1;
  }
  return -1;
}

const matches = (text, marker) => markerIndex(text, marker) !== -1;

// Where the point of this entry starts. A note often opens with provenance
// ("Stage C of SW-005, depends on…") and reaches the decision three sentences
// later, so a clip taken from character zero shows the preamble and hides the
// thing worth reading.
export function pointIndex(text, kindKey) {
  if (typeof text !== 'string') return 0;
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
// A lone high surrogate renders as a replacement glyph, so a clip that lands
// mid-emoji drops the orphan rather than shipping a broken character.
const dropOrphanSurrogate = (s) => (/[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s);

export function excerpt(entry, max = 240) {
  const text = typeof entry?.text === 'string' ? entry.text : '';
  const from = pointIndex(text, entry?.kind);
  const body = text.slice(from);
  const head = from > 0 ? '…' : '';
  // A max of 0, 2 or NaN used to make slice() count from the END, which
  // returned more than the limit for some values and the empty string for
  // others — not even monotonic in max.
  const limit = Number.isFinite(max) ? Math.floor(max) : Infinity;
  if (head.length + body.length <= limit) return head + body;
  const room = Math.max(1, limit - head.length - 1);
  return `${head}${dropOrphanSurrogate(body.slice(0, room)).trimEnd()}…`;
}

export function classify(text, isFirst = false) {
  if (typeof text !== 'string') return isFirst ? 'brief' : 'outcome';
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

// A resolution marker only resolves anything if it is being ASSERTED. Matching
// the bare word meant "Not yet fixed — parked until he answers" closed the
// question it was reporting: the card said the item was open, and the module
// said zero open, dropping it from the standup, from recall and from the status
// line. That is this module's purpose exactly inverted, so the clause in front
// of the marker is checked for the words that flip it.
const NEGATION = /\b(not|never|isn'?t|aren'?t|wasn'?t|no longer|nothing|none|yet to be|still|almost|pending|must be|needs? to be|waiting|unable|cannot|can'?t)\b/i;
const CLAUSE_BREAKS = ['.', '!', '?', ';', '—', ':'];

export const resolves = (text) => RESOLUTION.some((m) => {
  const i = markerIndex(text, m);
  if (i === -1) return false;
  const from = CLAUSE_BREAKS.reduce((max, ch) => Math.max(max, text.lastIndexOf(ch, i - 1)), -1) + 1;
  return !NEGATION.test(text.slice(from, i));
});

// Paths as they appear in prose. Requiring a known source extension keeps
// ordinary sentences from turning into false links; the trailing punctuation
// strip stops "app.js." and "app.js" being two different files.
const PATH_RE = /\b[\w./-]+\.(?:mjs|js|json|css|html|md)\b/g;

// A path never contains whitespace, so the text is split first and each token
// matched on its own. Running the pattern across the whole note let it
// backtrack quadratically over any long unbroken run of path-ish characters:
// 24k characters took 2.9 seconds and 120k never finished. A pasted data URI
// or base64 blob in a note was enough, and this runs on the browser's main
// thread and inside every standup. Tokens longer than a real path are skipped
// outright rather than parsed.
const MAX_PATH_TOKEN = 300;

export function refs(text) {
  const seen = new Set();
  if (typeof text !== 'string') return [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.length > MAX_PATH_TOKEN) continue;
    for (const raw of token.match(PATH_RE) || []) {
      const path = raw.replace(/^[./]+/, '').replace(/[.,;:]+$/, '');
      if (path) seen.add(path);
    }
  }
  return [...seen];
}

// Function names as they appear in prose. This matters more than it looks: the
// single most valuable note in this repo — the one about live locks being
// broken — names no file at all. It talks about isStale(), breakLock() and
// sweepTmp(), because that is how you naturally write down what went wrong.
// Indexing only paths made that note unreachable from the file it is about.
// The lookbehind covers any unicode letter or digit, not just ASCII: \b alone
// fired in the middle of "señor()" and indexed a function called "or".
const SYMBOL_RE = /(?<![\p{L}\p{N}_$])([A-Za-z_$][\w$]*)\(\)/gu;

export function symbols(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  for (const [, name] of text.matchAll(SYMBOL_RE)) seen.add(name);
  return [...seen];
}

const namesIn = (entry) => [
  ...(entry?.syms || []).map((x) => String(x).toLowerCase()),
  ...(entry?.refs || []).map((r) => String(r).toLowerCase().split('/').pop()),
];

// Below this length a suffix match is noise rather than evidence. tokensFor()
// hands recall every name a file declares, including the one- and two-character
// ones, so a bare endsWith let the token "t" match commit() and rank an
// unrelated card as being about the file.
const MIN_SUFFIX = 3;

const hits = (entry, token) => {
  const names = namesIn(entry);
  if (names.includes(token)) return true;
  return token.length >= MIN_SUFFIX && names.some((n) => n.endsWith(token));
};

// True if the entry names any of these tokens — a file, a function, whatever
// the caller knows the code by.
export function mentionsAny(entry, tokens) {
  const want = (tokens || []).map((t) => String(t).toLowerCase()).filter(Boolean);
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
export const tokenScore = (entry, tokens) => (tokens || []).filter((t) => hits(entry, t)).length;

// One entry per note segment, newest card first. `at` is the best timestamp the
// card can offer — a segment is not individually dated, and inventing a date
// would be worse than admitting the note only knows the card's own clock.
export function memoryEntries(cards, projectId) {
  const out = [];
  // Every card any entry explicitly resolves, mapped to its earliest resolver.
  // Collected in a first pass because resolution crosses cards: SW-012 fixed
  // the SPEC that SW-011 left stale, and no amount of same-card reading could
  // ever see it.
  const resolvedCards = new Map();
  for (const card of cardsOf(cards, projectId)) {
    for (const seg of noteSegments(card.note)) {
      if (seg.resolves && !resolvedCards.has(seg.resolves)) resolvedCards.set(seg.resolves, card.id);
    }
  }
  for (const card of cardsOf(cards, projectId)) {
    const segments = noteSegments(card.note);
    segments.forEach((seg, i) => {
      // A stored kind is a fact and wins; classification remains the guess it
      // always was, for prose and for unlabelled entries. This is the mention-
      // vs-use fix: an entry that QUOTES a marker word cannot misfile itself
      // when its kind is stated.
      const kind = seg.kind || classify(seg.text, i === 0);
      const laterResolves = segments.slice(i + 1).some((s) => resolves(s.text) || s.resolves === card.id);
      const resolver = resolvedCards.get(card.id);
      // A card cannot settle its own past by pointing at itself from the same
      // entry, but an explicit resolves from a LATER entry or another card is
      // an assertion, not a guess.
      const settledBy = resolver && resolver !== card.id ? resolver : (laterResolves ? card.id : null);
      out.push({
        id: `${card.id}#${i}`,
        card: card.id,
        title: card.title,
        status: card.status,
        commit: card.commit,
        branch: card.branch,
        // The entry's own clock when it has one; the card's otherwise.
        at: seg.t || card.shipped || card.pushed || card.created,
        kind,
        // Only an open item can be settled — by later assertive prose on the
        // same card, or by any entry anywhere that explicitly resolves this card.
        superseded: kind === 'open' && settledBy != null,
        settledBy: kind === 'open' ? settledBy : null,
        resolves: seg.resolves || null,
        text: seg.text,
        refs: refs(seg.text),
        syms: symbols(seg.text),
      });
    });
  }
  return out.sort((a, b) => atMs(b) - atMs(a));
}

// The live open items: what is genuinely still waiting, superseded ones removed.
// An undated entry sorts last instead of poisoning the comparator: Date.parse
// of a missing date is NaN, one NaN comparison scrambles the neighbours, and
// several leave the list in insertion order with no sorting at all.
const atMs = (e) => {
  const t = Date.parse(e?.at);
  return Number.isNaN(t) ? -Infinity : t;
};

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
    for (const path of e?.refs || []) {
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
  const query = String(file ?? '').trim().toLowerCase();
  if (!query) return false;
  // A query carrying a directory is asking about THAT file. Reducing everything
  // to a basename made packages/auth/index.js and docs/index.js one file, so a
  // question about the docs one returned the auth one's security note.
  const withDir = query.includes('/');
  return (entry?.refs || []).some((r) => {
    const path = String(r).toLowerCase();
    if (withDir) return path === query || path.endsWith(`/${query}`) || query.endsWith(`/${path}`);
    const name = path.split('/').pop();
    return name === query || (query.length >= MIN_SUFFIX && name.includes(query));
  });
}

// Retrieval, as opposed to display. The caller is a session about to do
// something, so results are ranked by what it would cost to miss rather than by
// date, and `dropped` is always reported — a silent truncation reads as "that
// is everything" when it is not.
export function recall(entries, { file, kind, query, tokens, limit = 10 } = {}) {
  const take = Number.isInteger(limit) && limit > 0 ? limit : 10;
  let out = entries || [];

  // `tokens` is the caller saying "here is everything this code is known by" —
  // the filename plus the names declared inside it. Matching on the filename
  // alone missed notes that only ever named the functions.
  let useful = [];
  if (tokens?.length) {
    // The filename is always kept: it is the most specific thing we were given.
    useful = distinctiveTokens(entries, tokens, file ? [String(file).split('/').pop()] : []);
    // Every token generic is not the same as no match. Filtering on an empty
    // token set is `[].some(...)` — false for everything — so recall answered
    // "nothing found" while holding twenty entries about exactly that file.
    if (useful.length) out = out.filter((e) => mentionsAny(e, useful));
    else if (file) out = out.filter((e) => mentionsFile(e, file));
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
    || atMs(b) - atMs(a));

  return {
    total: ranked.length,
    dropped: Math.max(0, ranked.length - take),
    matchedOn: useful,
    entries: ranked.slice(0, take),
  };
}

export function searchEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase();
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
