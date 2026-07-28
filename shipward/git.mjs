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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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
        id: card.id, rule: 'not-on-trunk', severity: 'wrong',
        says: `${card.status}, commit ${card.commit}`,
        git: `${card.commit} is not an ancestor of ${facts.trunk}`,
        fix: null,      // needs a human: the board may be right and the branch rewritten
      });
    }

    // 2. A branch with work behind it and no sha on the card. SW-008 carried a
    //    null commit for two days.
    if (branch && branch.ahead > 0 && !card.commit) {
      findings.push({
        id: card.id, rule: 'missing-commit', severity: 'incomplete',
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
        id: card.id, rule: 'merged-not-pushed', severity: 'stale',
        says: card.status,
        git: `${card.commit} is already on ${facts.trunk}${branch ? ` (${branch.name})` : ' (branch gone)'}`,
        fix: { status: 'pushed' },
      });
    }

    // 4. Work exists against a card nobody started. This is the SW-005 slip:
    //    five hundred lines written while the card sat in Backlog.
    if (branch && branch.ahead > 0 && card.status === 'backlog') {
      findings.push({
        id: card.id, rule: 'started-without-saying', severity: 'wrong',
        says: 'backlog',
        git: `${branch.name} has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} beyond ${facts.trunk}`,
        fix: { status: 'claude' },
      });
    }

    // 5. In progress with nothing to show for it.
    if (card.status === 'claude' && !branch) {
      findings.push({
        id: card.id, rule: 'no-branch', severity: 'suspicious',
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
      id: null, rule: 'untracked-branch', severity: 'missing',
      says: 'no card references this branch',
      git: `${name} has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} beyond ${facts.trunk}`,
      fix: null,      // a card needs a title, and only a human or Claude can write one
    });
  }

  return findings;
}

export const summarise = (findings) => {
  if (!findings.length) return 'The board matches git.';
  const fixable = findings.filter((f) => f.fix).length;
  return `${findings.length} discrepanc${findings.length === 1 ? 'y' : 'ies'} between the board and git, `
    + `${fixable} of them applicable automatically.`;
};
