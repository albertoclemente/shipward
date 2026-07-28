// The one place a git-derived fact is allowed to become a board change.
//
// SW-022 taught the tracker to read the repository and SW-023 put that reading
// in front of every session — but both stopped at reporting. A tool that can
// prove the board is wrong and then waits to be asked has moved the work, not
// removed it: someone still has to notice the report, agree with it, and run
// the command. That someone is the same someone who forgot to move the card.
//
// So: what git can prove, git applies. What git can only infer waits for an
// explicit ask. What git can merely wonder about is never written at all. The
// tiers live in git.mjs with the rules that produce them; this file is only the
// writer.
//
// WHY A SEPARATE FILE, AND WHY EVERYTHING GOES THROUGH IT: the SessionStart
// hook and the sync tool both need to turn findings into card changes, and
// SW-023 already paid for this lesson once — two answers to "what does git mean
// for the board" would eventually disagree, and the hook is the one nobody
// would think to re-check. The planning is pure and shared (reconcilePlan); the
// writing is here and shared; the callers only choose a level.
import { auditBoard, reconcilePlan, summarise, REPO } from './git.mjs';
import { mutate } from './tracker-store.mjs';
import { applyTransition, feedAdd } from './public/lib.js';
import { appendedNote } from './public/memory-lib.js';

// YYYY-MM-DD, for the note. The board is a claim about now; a note is a record
// of then, and an undated one is indistinguishable from a fresh assertion.
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

// What actually moved on one card. Shared with describeApplied deliberately:
// the first version of this built the feed line from the status alone, so a
// commit-only fix was announced as "SW-024 → claude" — a status change that
// never happened, written into the log that exists to say what did.
const changeText = (a) => {
  const bits = [];
  if (a.to !== a.was) bits.push(`${a.was} → ${a.to}`);
  if (a.commit) bits.push(`commit ${a.commit}`);
  if (a.branch) bits.push(`branch ${a.branch}`);
  return bits.join(', ');
};

const feedMsg = (applied) => (applied.length === 1
  ? `Reconciled with git — ${applied[0].id} ${changeText(applied[0])}`
  : `Reconciled with git — ${applied.length} cards corrected from the repository`);

// Never throws. A reconciliation that cannot run must read as "we did not
// know", never as "nothing was wrong" — the same rule the audit already
// follows, and the reason a failure returns a reason instead of an empty
// result.
//
// Takes cards from the caller's own read, so the audit and the write see the
// same board and a caller holding a doc does not pay for a second read.
export async function reconcile(cards, projectId, { cwd = REPO, level = 'certain', signal, now = new Date() } = {}) {
  let findings = [];
  let why = null;
  try {
    const out = await auditBoard(cards, projectId, cwd);
    findings = out.findings;
    why = out.reason;
  } catch {
    why = 'the audit could not be run';
  }
  if (why) return { ok: false, reason: why, applied: [], held: [], findings: [] };

  const { updates, held } = reconcilePlan(findings, { level, on: today(now) });
  if (!updates.length) return { ok: true, reason: null, applied: [], held, findings };

  const applied = [];
  await mutate((doc) => {
    for (const u of updates) {
      const i = doc.cards.findIndex((c) => c.id === u.id);
      // The board moved between the audit and the write — another writer had
      // the lock first. Skipping is right: the finding was derived from a card
      // that no longer exists, and next session's audit will look again.
      if (i === -1) continue;
      const card = doc.cards[i];
      let next = u.status && u.status !== card.status
        ? (applyTransition(card, u.status, new Date().toISOString()) || { ...card })
        : { ...card };
      if (u.commit) next.commit = u.commit;
      if (u.branch) next.branch = u.branch;
      // A dated evidence entry, stated as such: "[git audit] …" is a record of
      // what was checked, and an explicit kind cannot be misread by the
      // classifier no matter what the audit text happens to quote.
      next.note = appendedNote(next.note, next.created,
        { t: new Date().toISOString(), kind: 'evidence', text: u.note });
      doc.cards[i] = next;
      applied.push({
        id: next.id, was: card.status, to: next.status, rules: u.rules,
        // Only what actually moved. A missing-commit fix leaves the status
        // alone, and reporting it as "backlog → backlog" describes a change
        // that did not happen.
        commit: next.commit !== card.commit ? next.commit : null,
        branch: next.branch !== card.branch ? next.branch : null,
      });
    }
    if (!applied.length) return doc;
    // One entry for the whole reconciliation. Twenty-three lines of bookkeeping
    // would bury the activity the feed exists to show.
    doc.feed = feedAdd(doc.feed, projectId, feedMsg(applied), new Date().toISOString(), 'claude');
    return doc;
  }, { signal });

  return { ok: true, reason: null, applied, held, findings };
}

// One line per correction, for a human or a session opener.
export const describeApplied = (applied) => applied
  .map((a) => `  ${a.id} ${changeText(a)} (${a.rules.join(', ')})`)
  .join('\n');

export { summarise };
