// A first board that is not empty (SW-067).
//
// setup.mjs used to seed `cards: []`, so a stranger's very first standup was
// blank — and the most persuasive thing this tool does, git correcting the board
// without being asked, cannot fire until they have logged a card, worked it and
// landed it. That is days away, long past the point most people stop looking.
//
// The fix is not to invent a board. It is to notice that a repository being
// onboarded usually ALREADY holds work git can vouch for: branches carrying
// commits the trunk does not have. One card each, and every field on it is a
// fact git already knew.
//
// Two rules keep it honest, and both matter more than the feature:
//
//   A merged branch is finished work. Filing it as backlog would state something
//   false on the first screen the user ever sees. A ref with nothing ahead of
//   the trunk is not work at all.
//
//   card.commit is left NULL on purpose. Setup is a wiring step, not a reader of
//   git state, and a branch head baked in at install time is stale the next time
//   anyone commits to that branch. Leaving it blank is the honest division of
//   labour — and it is also the demo, because "names a branch but records no
//   sha" is a CERTAIN-tier finding, so the very first SessionStart fills it in
//   and writes the [git audit] line. The tool corrects the board unasked in
//   session one instead of session ten.
//
// Everything here is pure. The git reading lives in git.mjs and the file writing
// in setup.mjs, so every rule below is testable without a repository.

// A first board that scrolls is its own kind of useless, and a repo with 40
// abandoned branches has 40 of them. Capped — and what the cap drops is
// REPORTED, never dropped in silence, the same rule the fleet's 16-desk cap
// follows: a truncation nobody mentions reads as full coverage.
export const SEED_CAP = 25;

const TYPE_BY_PREFIX = { feat: 'feature', feature: 'feature', fix: 'bug', bug: 'bug', hotfix: 'bug', chore: 'chore', docs: 'chore', refactor: 'chore', test: 'chore' };

// `fix/login-crash` → bug. Unprefixed or unknown → feature, because "some work
// exists here" is the only claim the branch name actually supports, and feature
// is the neutral one to correct later.
export function typeFromBranch(name) {
  const prefix = String(name).split('/')[0].toLowerCase();
  return TYPE_BY_PREFIX[prefix] ?? 'feature';
}

// `fix/login-crash` → "login crash". The branch name is the only description
// anybody wrote, so it is used as-is rather than dressed up into a sentence the
// user never said.
export function titleFromBranch(name) {
  const withoutPrefix = String(name).includes('/') ? String(name).slice(String(name).indexOf('/') + 1) : String(name);
  const words = withoutPrefix.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return String(name);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Which branches deserve a card, most work first so the cap keeps the busiest.
// Ties break on name so two runs on one repo produce the same board.
export function seedable(branches) {
  return [...(branches ?? [])]
    .filter((b) => b && !b.merged && (b.ahead ?? 0) > 0)
    .sort((a, b) => (b.ahead - a.ahead) || a.name.localeCompare(b.name));
}

// The note that ships with a seeded card: what git held at install time, said as
// a claim about then rather than about now. `brief` and not `evidence` — nothing
// was verified here, a branch was read.
export function seedNote(branch, log, nowIso) {
  const head = [
    `SEEDED AT SETUP from the branch ${branch.name}, which has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'}`,
    `the trunk does not. Nobody wrote this card — it is what git already held on ${String(nowIso).slice(0, 10)},`,
    'filed so the board starts with something true rather than empty. The title is the branch name;',
    'type, priority and effort are guesses from that name alone and are meant to be corrected.',
    'No sha is recorded on purpose: the branch head moves, and the git audit fills it in at session start.',
  ].join(' ');
  const subjects = log?.known && log.subjects.length
    ? ` Commits, newest first: ${log.subjects.map((s) => `"${s}"`).join('; ')}${log.more ? ` (+${log.more} more)` : ''}.`
    : ' Its commit subjects could not be read at setup time.';
  return { card: null, t: nowIso, kind: 'brief', text: head + subjects };
}

// The board itself. `nextIdFor` is injected rather than imported so this stays
// pure and so setup can allocate against a tracker that may already have cards.
export function seedCards(branches, { project, nextIdFor, logs = {}, now, cap = SEED_CAP }) {
  const all = seedable(branches);
  const taking = all.slice(0, cap);
  const dropped = all.slice(cap);
  const cards = [];
  const notes = [];
  const ids = [];
  for (const b of taking) {
    const id = nextIdFor(ids);
    ids.push(id);
    cards.push({
      id,
      p: project,
      title: titleFromBranch(b.name),
      type: typeFromBranch(b.name),
      pri: 'P2',
      effort: 'M',
      status: 'backlog',
      claude: null,
      branch: b.name,
      commit: null,          // deliberate — see the header
      created: now,
    });
    notes.push({ ...seedNote(b, logs[b.name], now), card: id });
  }
  return { cards, notes, dropped, considered: all.length };
}

/* ── the preview ─────────────────────────────────────────────
   Printed at the end of EVERY setup run, seeded or not, because an opt-in flag
   nobody sees is the empty board with extra steps. Read-only and pure: it
   returns lines, it does not print them, and it never claims more than the
   `ok` flag it was handed. */
export function previewLines(git, { seeded = null, command = '' } = {}) {
  const out = [];
  if (!git?.ok) {
    out.push(`  git      could not be read (${git?.reason ?? 'unknown'}) — the board starts empty`);
    return out;
  }
  const candidates = seedable([...(git.branches?.values?.() ?? git.branches ?? [])]);
  out.push(`  trunk    ${git.trunk}`);

  if (!candidates.length) {
    out.push('  branches none with unmerged work — nothing to seed, and nothing is missing');
    out.push('');
    out.push('  Your board starts empty, which is honest: this repo has no work in flight that');
    out.push('  git can point at. The first card you log is where the memory starts.');
    return out;
  }

  const shown = candidates.slice(0, 5);
  out.push(`  branches ${candidates.length} with unmerged work`);
  for (const b of shown) out.push(`             ${b.name} · ${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead`);
  if (candidates.length > shown.length) out.push(`             …and ${candidates.length - shown.length} more`);

  out.push('');
  if (seeded && !seeded.cards.length) {
    // Re-running with the flag on a board that already covers every branch. Not
    // a failure and not a no-op worth apologising for — say which it was.
    out.push('  Nothing seeded: every branch above is already named by a card. Seeding is safe to');
    out.push('  re-run for exactly this reason — two cards on one branch would be the board');
    out.push('  contradicting itself.');
  } else if (seeded) {
    out.push(`  Seeded ${seeded.cards.length} backlog card${seeded.cards.length === 1 ? '' : 's'}, one per branch, with no sha recorded —`);
    out.push('  the git audit fills those in at your first session start, and says so on the card.');
    if (seeded.dropped.length) {
      out.push(`  NOT seeded: ${seeded.dropped.length} further branch${seeded.dropped.length === 1 ? '' : 'es'} beyond the cap of ${SEED_CAP}`);
      out.push(`             (${seeded.dropped.slice(0, 5).map((b) => b.name).join(', ')}${seeded.dropped.length > 5 ? ', …' : ''}) — log them by hand if they are live.`);
    }
  } else {
    out.push('  Your board is empty. To start it from what git already knows —');
    out.push(`      ${command}`);
    out.push('  one backlog card per branch above. Nothing is invented: the title is the branch');
    out.push('  name and the note carries its commit subjects. Merged branches are left alone.');
  }
  return out;
}
