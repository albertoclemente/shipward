// What git says, and what that means for the board.
//
// The tracker records what someone remembered to write down. Git records what
// actually happened. Everything the board asserts by hand can drift, and on
// 2026-07-27 all three of these were true at once: a card carried a null commit
// for two days, the SPEC held nine false statements, and five hundred lines
// were written against a card still sitting in Backlog because nobody called
// start. Hooks can nag, but only git can say the board is WRONG.
//
// The split is the same one lib.js uses: readGit() does the I/O and nothing
// else, deriveFindings() is pure and holds every rule, so the rules can be
// tested exhaustively without a repository and the I/O can be tested once
// against a real one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
// SHIPWARD_REPO overrides the repository, mirroring SHIPWARD_TRACKER. It exists
// so the audit can be tested against a staged repository instead of this one —
// without it the only way to exercise a finding is to break the real board.
// Same resolution ladder as the tracker (SW-033): explicit env, the repo you
// are standing in, then this one. The middle rung keeps the audit honest when
// one central install serves many repos — the board of the repo you are in is
// compared against THAT repo's git, never against Shipward's own.
const CWD_REPO = process.cwd();
export const REPO = process.env.SHIPWARD_REPO
  || (existsSync(join(CWD_REPO, '.git')) ? CWD_REPO : join(dirname(fileURLToPath(import.meta.url)), '..'));

// Never throws, never rejects. A missing repo, a detached HEAD, a git that is
// not installed — all of it is "we do not know", which must read differently
// from "nothing is wrong".
async function git(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 1 << 24 });
    return stdout.trim();
  } catch {
    return null;
  }
}

const lines = (out) => (out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []);

/* ── reading ─────────────────────────────────────────────── */

export async function readGit(cwd = REPO) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside !== 'true') return { ok: false, reason: 'not a git repository' };

  // The trunk is whatever this repo actually calls it.
  let trunk = null;
  for (const name of ['main', 'master', 'trunk']) {
    if (await git(['rev-parse', '--verify', '--quiet', name], cwd)) { trunk = name; break; }
  }
  if (!trunk) return { ok: false, reason: 'no main, master or trunk branch' };

  const local = lines(await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd));
  const remote = lines(await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'], cwd))
    .map((r) => r.replace(/^[^/]+\//, ''))
    .filter((r) => r !== 'HEAD');
  const merged = new Set(lines(await git(['branch', '--merged', trunk, '--format=%(refname:short)'], cwd)));

  const branches = new Map();
  for (const name of new Set([...local, ...remote])) {
    if (name === trunk) continue;
    const head = await git(['rev-parse', '--short', name], cwd);
    // Commits this branch has that the trunk does not — the honest measure of
    // "is there work here", rather than merely "does the ref exist".
    const ahead = await git(['rev-list', '--count', `${trunk}..${name}`], cwd);
    branches.set(name, {
      name,
      head,
      ahead: Number(ahead ?? 0) || 0,
      merged: merged.has(name),
      local: local.includes(name),
    });
  }

  return { ok: true, trunk, branches };
}

// How far the tree has moved since a commit (SW-044) — the measurement behind
// "evidence expires".
//
// Asked once per DISTINCT sha, never once per entry: a card can carry a dozen
// evidence entries from the same commit, and spawning is the cost (see the note
// on trunkIndex). The changed-file list is bounded for the same reason a note
// is bounded — this is read into a reply a model pays for.
const DRIFT_FILE_CAP = 200;

export async function driftSince(shas, cwd = REPO) {
  const out = {};
  for (const sha of new Set((shas || []).filter(Boolean))) {
    // Does this commit exist here at all? A sha from another machine, or from a
    // branch that was rebased away, must read as unknown rather than as zero
    // commits since — which would be indistinguishable from "still current".
    const exists = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd);
    if (!exists) { out[sha] = { known: false }; continue; }
    const count = await git(['rev-list', '--count', `${sha}..HEAD`], cwd);
    if (count === null) { out[sha] = { known: false }; continue; }
    const commits = Number(count) || 0;
    const changed = commits === 0
      ? []
      : lines(await git(['diff', '--name-only', `${sha}..HEAD`], cwd)).slice(0, DRIFT_FILE_CAP);
    out[sha] = { known: true, commits, changed };
  }
  return out;
}

// One list of what is on the trunk, instead of one process per card.
// merge-base --is-ancestor is cheap but a process spawn is not: 22 of them cost
// 134ms sequentially and no less in parallel, because spawning is the cost.
// This is a single call. The window is bounded so a very old repository cannot
// make session start expensive; anything outside it falls back to asking
// directly, which is correct just slower.
const TRUNK_WINDOW = 5000;

// What tree a check just ran against (SW-043). Two facts, and the honest third
// state: `sha` is null when git cannot answer, which must not read as a clean
// tree at an unknown commit.
//
// `dirty` is the load-bearing one. A check that passed over uncommitted changes
// proves something nobody else can reproduce and that no later session can
// re-derive from the sha, so the evidence has to carry the caveat with it
// rather than let a reader assume the commit is what was tested.
export async function headState(cwd = REPO) {
  const sha = await git(['rev-parse', '--short', 'HEAD'], cwd);
  if (sha === null) return { sha: null, dirty: false, known: false };
  // --porcelain covers staged, unstaged and untracked in one call; empty means
  // the tree is exactly the commit.
  const status = await git(['status', '--porcelain'], cwd);
  return { sha, dirty: status === null ? false : status.length > 0, known: status !== null };
}

export async function trunkIndex(trunk, cwd = REPO) {
  const out = await git(['rev-list', `--max-count=${TRUNK_WINDOW}`, trunk], cwd);
  if (out === null) return null;
  // Keyed on the abbreviation git itself hands out, which is what a card holds.
  return new Set(lines(out).map((sha) => sha.slice(0, 7)));
}

// Is this commit already on the trunk? The branch may be long deleted — which
// is the normal state after a merge — so the sha is the only thing left to ask.
export async function isOnTrunk(sha, trunk, cwd = REPO) {
  if (!sha) return null;
  const known = await git(['cat-file', '-e', `${sha}^{commit}`], cwd);
  if (known === null) return null;                       // unknown sha: say so, do not guess
  const merged = await git(['merge-base', '--is-ancestor', sha, trunk], cwd);
  return merged !== null;
}

/* ── the rules ───────────────────────────────────────────── */
// Each one exists because it actually happened.
//
// Every finding carries a CERTAINTY, because "we found a fix object" is not the
// same claim as "git is right about this". The three tiers decide who is
// allowed to write, and they are the whole difference between a tool that
// reports drift and one that removes it:
//
//   certain   git is the witness AND the correction is a fact, so it is applied
//             without being asked. Only two rules qualify.
//   proposed  git proves the board is WRONG but the correction is an inference.
//             A branch with commits proves `backlog` is false; it cannot say
//             whether the card is claude or review. Needs an explicit apply.
//   reported  git can only raise a question. Never written by anything.
//
// THE PROPERTY THAT MAKES AUTOMATIC APPLICATION SAFE: every `certain` rule is
// monotonic. It fills a blank, or it confirms progress git can prove — in
// flight to pushed, no sha to a sha. Nothing in this tier walks a card
// backwards, so a human who moves a card ahead of git is never overruled by it.
// Anything that could retract a claim (not-on-trunk) is deliberately `reported`.
export const CERTAIN = 'certain';
export const PROPOSED = 'proposed';
export const REPORTED = 'reported';

const BRANCH_RE = /^(feat|fix|chore)\//;

export function deriveFindings(cards, facts) {
  if (!facts?.ok) return [];
  const findings = [];
  const claimed = new Set();

  for (const card of cards) {
    if (card.branch) claimed.add(card.branch);
    const branch = card.branch ? facts.branches.get(card.branch) : null;
    const onTrunk = card.onTrunk ?? null;      // resolved by the caller, which can do I/O

    // 1. The card says it shipped, git says it never landed.
    if ((card.status === 'pushed' || card.status === 'shipped') && onTrunk === false) {
      findings.push({
        id: card.id, rule: 'not-on-trunk', severity: 'wrong', certainty: REPORTED,
        says: `${card.status}, commit ${card.commit}`,
        git: `${card.commit} is not an ancestor of ${facts.trunk}`,
        fix: null,      // needs a human: the board may be right and the branch rewritten
      });
    }

    // 2. A branch with work behind it and no sha on the card. SW-008 carried a
    //    null commit for two days.
    if (branch && branch.ahead > 0 && !card.commit) {
      findings.push({
        // Certain: this fills a blank the branch already answers, rather than
        // overwriting anything the board claims.
        id: card.id, rule: 'missing-commit', severity: 'incomplete', certainty: CERTAIN,
        says: 'no commit recorded',
        git: `${branch.name} is at ${branch.head}`,
        fix: { commit: branch.head },
      });
    }

    // 3. The work is on the trunk, but the board still has it in flight.
    //
    // Driven by the recorded commit rather than by `git branch --merged`, which
    // was the first false positive this tool produced — about the very card
    // being written on it. A branch freshly cut from the tip has no commits of
    // its own, so --merged lists it, and "no work yet" is indistinguishable
    // from "work landed" by that signal alone. A commit that is provably an
    // ancestor of the trunk is not ambiguous, and it keeps working after the
    // branch is deleted, which is the normal state after a merge.
    if (onTrunk === true && (card.status === 'claude' || card.status === 'review')) {
      findings.push({
        // Certain: an ancestor of the trunk is not an opinion, and the move is
        // forwards. This is the rule the whole reconciler exists for.
        id: card.id, rule: 'merged-not-pushed', severity: 'stale', certainty: CERTAIN,
        says: card.status,
        git: `${card.commit} is already on ${facts.trunk}${branch ? ` (${branch.name})` : ' (branch gone)'}`,
        fix: { status: 'pushed' },
      });
    }

    // 4. Work exists against a card nobody started. This is the SW-005 slip:
    //    five hundred lines written while the card sat in Backlog.
    if (branch && branch.ahead > 0 && card.status === 'backlog') {
      findings.push({
        // Proposed, not certain: git proves `backlog` is false, and stops
        // there. Whether the work is still in progress or finished and waiting
        // is a fact about a person, and no commit records it. `claude` is the
        // safer of the two guesses — understating progress cannot close a card
        // nobody looked at — but it is still a guess, so it waits to be asked.
        id: card.id, rule: 'started-without-saying', severity: 'wrong', certainty: PROPOSED,
        says: 'backlog',
        git: `${branch.name} has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} beyond ${facts.trunk}`,
        fix: { status: 'claude' },
      });
    }

    // 5. In progress with nothing to show for it.
    if (card.status === 'claude' && !branch) {
      findings.push({
        id: card.id, rule: 'no-branch', severity: 'suspicious', certainty: REPORTED,
        says: card.branch ? `working on ${card.branch}` : 'working, no branch named',
        git: card.branch ? `${card.branch} does not exist` : 'no branch on the card',
        fix: null,      // it may simply not have been created yet
      });
    }
  }

  // 6. Work in git that the board has never heard of.
  for (const [name, branch] of facts.branches) {
    if (claimed.has(name) || !BRANCH_RE.test(name) || branch.ahead === 0) continue;
    findings.push({
      id: null, rule: 'untracked-branch', severity: 'missing', certainty: REPORTED,
      says: 'no card references this branch',
      git: `${name} has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} beyond ${facts.trunk}`,
      fix: null,      // a card needs a title, and only a human or Claude can write one
    });
  }

  return findings;
}

// The whole audit, in one place, because two callers need it — the sync tool
// and the SessionStart hook — and two implementations of "what does git say
// about the board" would eventually disagree about it.
export async function auditBoard(cards, projectId, cwd = REPO) {
  const facts = await readGit(cwd);
  if (!facts.ok) return { facts, findings: [], reason: facts.reason };

  const mine = cards.filter((c) => c.p === projectId);
  // Only where the answer can change a finding.
  const needsTrunk = new Set(['pushed', 'shipped', 'claude', 'review']);
  const index = await trunkIndex(facts.trunk, cwd);
  const resolved = await Promise.all(mine.map(async (c) => {
    if (!c.commit || !needsTrunk.has(c.status)) return { ...c, onTrunk: null };
    if (index?.has(String(c.commit).slice(0, 7))) return { ...c, onTrunk: true };
    // Not in the window, or no index at all: ask about this one directly rather
    // than reporting a false "never landed".
    return { ...c, onTrunk: await isOnTrunk(c.commit, facts.trunk, cwd) };
  }));
  return { facts, findings: deriveFindings(resolved, facts), reason: null };
}

/* ── the plan ────────────────────────────────────────────── */

// Findings in, card updates out. Pure, and deliberately so: this is the
// function that decides what gets written to the board without anyone asking,
// which makes it the one that most needs testing without a repository in the
// way.
//
// `level` is who is asking. The SessionStart hook asks at 'certain' and writes
// silently. sync({apply:true}) asks at 'all', because being asked twice is what
// buys the inference tier. Nothing reaches 'reported'.
const LEVELS = { certain: [CERTAIN], all: [CERTAIN, PROPOSED], none: [] };

const fixText = (fix) => Object.entries(fix).map(([k, v]) => `${k} → ${v}`).join(', ');

// Why the card moved, in the card's own note. A schema field would have been
// less work and worse: a marker only the desk can render tells a future session
// nothing, and the note is the thing that gets read. Dated because the board is
// a claim about now and the note is a record of then.
export const reason = (f, on = '') =>
  `[git audit${on ? ` ${on}` : ''}] ${fixText(f.fix)} — ${f.git}. The board said ${f.says}.`;

export function reconcilePlan(findings, { level = 'certain', on = '' } = {}) {
  const allow = new Set(LEVELS[level] ?? LEVELS.certain);
  const byId = new Map();
  const held = [];
  for (const f of findings) {
    if (!f.id || !f.fix || !allow.has(f.certainty)) { held.push(f); continue; }
    // One update per card, not one per rule: a backlog card with commits and no
    // sha trips two rules at once, and two updates for the same id would append
    // the note twice and read like two separate audits.
    const prev = byId.get(f.id);
    if (prev) {
      Object.assign(prev, f.fix);
      prev.note += ` ${reason(f, on)}`;
      prev.rules.push(f.rule);
    } else {
      byId.set(f.id, { id: f.id, ...f.fix, note: reason(f, on), rules: [f.rule] });
    }
  }
  return { updates: [...byId.values()], held };
}

export const summarise = (findings) => {
  if (!findings.length) return 'The board matches git.';
  const count = (t) => findings.filter((f) => f.certainty === t && f.fix).length;
  const settled = count(CERTAIN);
  const proposed = count(PROPOSED);
  const human = findings.length - settled - proposed;
  const parts = [];
  if (settled) parts.push(`${settled} git can settle on its own`);
  if (proposed) parts.push(`${proposed} it can propose`);
  if (human) parts.push(`${human} needing a human`);
  return `${findings.length} discrepanc${findings.length === 1 ? 'y' : 'ies'} between the board and git`
    + `${parts.length ? ` — ${parts.join(', ')}` : ''}.`;
};
