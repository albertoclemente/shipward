// What the board asserts that nothing can vouch for.
//
// SW-045. git.mjs already defines a `reported` tier — findings git can prove
// are wrong but cannot settle — and deliberately never writes it. That was the
// right call and it left the most interesting data in the system invisible:
// nothing has ever shown it to anyone.
//
// This is that surface. It reports; it never writes. Every rule here is a
// question a human answers, which is exactly the tier's existing rule.
//
// The split mirrors git.mjs and memory-lib: everything here is PURE. git's
// answer and the working tree arrive as data, so all five rules can be
// exercised without a repository, and the one caller that has a repo does the
// I/O. Three different kinds of question live here — what git can disprove,
// what the board's own arithmetic shows, and what the memory is missing — and
// they are kept apart underneath even though they render as one list.

// A review that has waited longer than this is not "in review", it is parked.
// Seven days because a solo developer's week is the natural unit: anything that
// survives a weekend was not actually waiting on a five-minute look.
export const STALE_REVIEW_DAYS = 7;

const DAY_MS = 86400_000;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The `reported` tier, and only it. `certain` is applied at session start and
// `proposed` is what sync({apply:true}) is for — neither is unsettled, so
// neither belongs on a panel about things nobody can settle.
export const REPORTED_RULES = new Set(['not-on-trunk', 'untracked-branch']);

// When this project started being able to verify anything (SW-043). Derived
// rather than stored: the earliest verification on the board IS the moment
// checks began working here, and a derived date cannot drift out of sync with
// the thing it describes.
//
// Cards handed back before it were never given the chance to be verified, and
// indicting them would fill this panel with fifty findings about the past on
// the day it ships — which teaches a reader to close it.
export function checksBegan(cards) {
  const stamps = cards
    .map((c) => Date.parse(c?.verification?.at))
    .filter((t) => !Number.isNaN(t));
  return stamps.length ? Math.min(...stamps) : null;
}

const handedBackAt = (card) => {
  const stamps = [card.pushed, card.shipped]
    .concat(Array.isArray(card.note) ? card.note.map((e) => e.t) : [])
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  return stamps.length ? Math.max(...stamps) : Date.parse(card.created);
};

/* ── the rules ───────────────────────────────────────────── */

// findings: what git.mjs derived, already tiered. tree: { dirtyPaths } from
// headState. now: injected so the tests are not a clock.
export function trustFindings(cards, {
  findings = [], tree = null, now = Date.now(), staleDays = STALE_REVIEW_DAYS,
} = {}) {
  const out = [];
  const byId = new Map(cards.map((c) => [c.id, c]));

  // 1 & 2. What git can disprove but not settle. Passed through rather than
  // re-derived: two implementations of "is this commit on the trunk" would
  // eventually disagree, and the desk would then contradict sync().
  for (const f of findings) {
    if (!REPORTED_RULES.has(f.rule)) continue;
    const card = f.id ? byId.get(f.id) : null;
    out.push(f.rule === 'not-on-trunk'
      ? {
        rule: f.rule,
        card: f.id || null,
        title: card?.title || null,
        headline: `${f.id} says it landed, and its commit is not on the trunk`,
        detail: `The board records ${card?.commit || 'a commit'} as pushed. git cannot find it on main. Either the branch was rewritten after the card was closed, or it never landed at all — git can tell you it is wrong, not which.`,
      }
      : {
        rule: f.rule,
        card: null,
        title: null,
        headline: `${f.branch || 'a branch'} is work no card claims`,
        detail: 'A branch with commits that no card names. Either it is finished work nobody logged, or it is abandoned — and only you know which.',
      });
  }

  // 3. Source changed with nothing in flight. The pre-edit hook warns about
  // this in the moment and cannot make anyone read it; this is the same fact
  // surviving the moment it happened.
  const working = cards.filter((c) => c.status === 'claude');
  const dirty = (tree?.dirtyPaths || []).filter(Boolean);
  if (dirty.length && !working.length) {
    out.push({
      rule: 'uncarded-changes',
      card: null,
      title: null,
      headline: `${plural(dirty.length, 'file')} changed with no card in progress`,
      detail: `${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''} — work that is not on a card is work the next session cannot see.`,
    });
  }

  // 4. Board arithmetic, no git involved: a review nobody has looked at.
  for (const c of cards) {
    if (c.status !== 'review') continue;
    const since = handedBackAt(c);
    const days = Math.floor((now - since) / DAY_MS);
    if (days < staleDays) continue;
    out.push({
      rule: 'stale-review',
      card: c.id,
      title: c.title,
      headline: `${c.id} has been waiting on you for ${plural(days, 'day')}`,
      detail: 'Handed back and not looked at since. A review column that only fills up stops being a queue.',
    });
  }

  // 5. Memory arithmetic: handed back since checks started working here, and
  // still carrying no evidence anything ever ran.
  const began = checksBegan(cards);
  if (began != null) {
    for (const c of cards) {
      if (c.status !== 'review' && c.status !== 'pushed') continue;
      if (c.verification) continue;
      if (handedBackAt(c) < began) continue;      // never had the chance
      out.push({
        rule: 'never-verified',
        card: c.id,
        title: c.title,
        headline: `${c.id} was handed back without a check running`,
        detail: 'Closed after this project declared its checks, with nothing recorded as having run. Not wrong — unproven, which reads the same on a board and does not read the same at all.',
      });
    }
  }

  return out;
}

// Ordered for a reader, not for a machine: what git can disprove comes first
// because it is the only category where the board is making a false claim right
// now. Within a rule, newest cards first.
const RULE_ORDER = ['not-on-trunk', 'untracked-branch', 'uncarded-changes', 'stale-review', 'never-verified'];

export const rankFindings = (findings) => [...findings].sort((a, b) => {
  const r = RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule);
  return r || String(b.card || '').localeCompare(String(a.card || ''));
});

// The one line above the panel. Says what was CHECKED as well as what was
// found: "nothing to report" and "we could not look" are different states, and
// a panel that renders them the same is worse than no panel.
export function trustLede(findings, { known = true } = {}) {
  if (!known) {
    return 'git could not be read here, so this covers only what the board can check about itself — nothing about what actually landed.';
  }
  if (!findings.length) {
    return 'Nothing unsettled. Every card that claims to have landed is on the trunk, every branch belongs to a card, and nothing has been waiting too long.';
  }
  const counts = new Map();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) || 0) + 1);
  const parts = RULE_ORDER.filter((r) => counts.has(r)).map((r) => `${counts.get(r)} ${LABEL[r]}`);
  return `${plural(findings.length, 'thing')} nothing can settle for you: ${parts.join(', ')}.`;
}

export const LABEL = {
  'not-on-trunk': 'claiming to have landed',
  'untracked-branch': 'unclaimed',
  'uncarded-changes': 'uncarded',
  'stale-review': 'waiting too long',
  'never-verified': 'unproven',
};

export const HEADING = {
  'not-on-trunk': 'Claims git contradicts',
  'untracked-branch': 'Work no card claims',
  'uncarded-changes': 'Changes with no card',
  'stale-review': 'Waiting on you',
  'never-verified': 'Closed without a check',
};
