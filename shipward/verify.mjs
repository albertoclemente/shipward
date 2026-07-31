// Running the check that gates done(), and saying only what it proved.
//
// SW-043. The board already refuses to take the agent's word about the COMMIT —
// git.mjs proves whether a sha reached the trunk. This is the same move about
// the WORK: done() runs a declared check and records the outcome against the
// tree it ran on.
//
// What it does not establish, and no copy here may imply: that the work is
// correct. A check exiting zero means a declared command exited zero at a named
// sha. An agent that writes a passing test for broken code defeats this
// entirely, which is exactly why the evidence carries the sha and the dirty
// flag instead of the bare word "verified".
//
// The split mirrors git.mjs: resolve() and clip() are pure and hold the rules,
// runCheck() does the I/O and nothing else. The spawn is injectable so the
// outcomes can be tested without launching anything.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { headState, REPO } from './git.mjs';

// Short on purpose. The check that gates a tool call is the fast one; a suite
// that needs longer belongs in CI, where nobody is waiting on the reply.
export const DEFAULT_TIMEOUT_MS = 120000;

// The note IS the memory: every standup, every recall and the SessionStart hook
// re-read it forever. A full test log written in here would be paid for on
// every future session, so what survives is the head and the tail with the
// elision stated. SW-041 files the same failure mode for recall.
export const OUTPUT_BUDGET = 2000;

/* ── pure ────────────────────────────────────────────────── */

// Which check applies, as a decision that can be explained. Absence is a first
// class answer here: "nothing was declared" and "the name is wrong" are
// different facts and the reply says which, rather than both arriving as
// silence that reads like success.
export function resolveCheck(project, card) {
  const declared = (project && typeof project.checks === 'object' && project.checks) || null;
  const named = card?.check;
  if (named) {
    const argv = declared?.[named];
    if (!Array.isArray(argv) || argv.length === 0) {
      return { name: named, argv: null, reason: `the card names check "${named}", which this project does not declare` };
    }
    return { name: named, argv };
  }
  const fallback = declared?.default;
  if (Array.isArray(fallback) && fallback.length > 0) return { name: 'default', argv: fallback };
  return { name: null, argv: null, reason: 'no check declared' };
}

export const timeoutOf = (project) =>
  Number.isInteger(project?.checkTimeoutMs) && project.checkTimeoutMs > 0
    ? project.checkTimeoutMs
    : DEFAULT_TIMEOUT_MS;

// Head and tail, never the middle, and the cut is stated. Clipping silently is
// how a reader comes to believe they have seen the whole failure.
export function clip(text, budget = OUTPUT_BUDGET) {
  const s = String(text ?? '').trim();
  if (s.length <= budget) return s;
  const half = Math.floor((budget - 40) / 2);
  const dropped = s.length - half * 2;
  return `${s.slice(0, half)}\n… ${dropped} bytes elided …\n${s.slice(-half)}`;
}

// The one place that decides what an outcome MEANS, so the tool reply, the note
// kind and the desk cannot each invent their own reading of the same exit code.
export function readOutcome(result) {
  if (!result) return { state: 'unverified', ok: false };
  if (result.timedOut) return { state: 'timeout', ok: false };
  if (result.spawnError) return { state: 'error', ok: false };
  return result.exit === 0 ? { state: 'pass', ok: true } : { state: 'fail', ok: false };
}

/* ── I/O ─────────────────────────────────────────────────── */

// Where a check's store lookups are sent instead of the live board. It does
// not exist and is never created: a check that reaches for the tracker gets a
// loud MissingTrackerError, which is the correct answer. A check is the code
// under test, and the board is not its business.
export const CHECK_TRACKER = join(tmpdir(), 'shipward-check-must-not-touch-the-board.json');

// SW-050. The child used to inherit the server's whole environment, including
// SHIPWARD_TRACKER pointing at the LIVE board — so a project whose check is its
// own test suite ran that suite holding a pointer to the real tracker. That is
// the exact shape of the SW-033 incident, where a test sandbox resolved the
// real tracker and its PUT tests replaced 32 cards and 111 feed entries.
//
// Unsetting alone would not have been enough, and that is the whole reason this
// PINS rather than scrubs: the store's resolution ladder is env, then the repo
// you are STANDING IN, then the install. A check runs with cwd set to the repo
// root, so removing the variable just falls through to the cwd rung and finds
// the very same live board. Pointing it somewhere that does not exist is what
// actually closes the door.
//
// Measured before choosing: with SHIPWARD_TRACKER pointed at a nonexistent path
// the whole suite still passes 424/424, so nothing here legitimately reads the
// ambient board — the inheritance was pure exposure with no upside.
//
// Everything else SHIPWARD_* goes too. A check that genuinely needs one is not
// served by adding an env field to the tracker: that file is written by the
// agent and by an unauthenticated PUT, so an env it controlled would be the
// same injection hole SW-043 refused for argv.
export function checkEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('SHIPWARD_')) out[k] = v;
  }
  out.SHIPWARD_TRACKER = CHECK_TRACKER;
  return out;
}

// No shell, ever. argv[0] is the program and the rest are arguments, so nothing
// in a check is parsed as syntax — see the validator in tracker-store.mjs,
// which refuses a check that is not an argv array at the write.
export function spawnCheck(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: checkEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exit: null, ms: 0, out: String(err.message || err), spawnError: true });
      return;
    }
    let out = '';
    let timedOut = false;
    // Bounded in memory too, not merely in what we keep: a runaway process that
    // prints for two minutes should not be buffered in full first.
    const take = (buf) => { if (out.length < OUTPUT_BUDGET * 8) out += buf; };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A child that ignores SIGTERM would otherwise hold the reply open past
      // the timeout that exists to bound it.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, timeoutMs);

    const finish = (exit, spawnError = false) => {
      clearTimeout(timer);
      resolve({ exit, ms: Date.now() - started, out: clip(out), timedOut, spawnError });
    };
    child.on('error', (err) => { out += String(err.message || err); finish(null, true); });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

// The whole run, outside any lock. mutate() holds the cross-process advisory
// lock for the length of its callback and waiters give up at 60s, so a check
// run inside one would starve the desk and every other session for as long as
// the suite takes. Callers run this first, then write briefly.
export async function runCheck(project, card, { cwd = REPO, run = spawnCheck } = {}) {
  const resolved = resolveCheck(project, card);
  // `unresolved` is a state of its own, not a quiet absence: a card naming a
  // check nobody declares has PROMISED evidence and produced none, which reads
  // differently from a project that never promised any.
  if (!resolved.argv) return { ran: false, ok: false, state: resolved.name ? 'unresolved' : 'none', ...resolved };

  const head = await headState(cwd);
  const result = await run(resolved.argv, { cwd, timeoutMs: timeoutOf(project) });
  const outcome = readOutcome(result);

  return {
    ran: true,
    name: resolved.name,
    argv: resolved.argv,
    ...outcome,
    exit: result.exit,
    ms: result.ms,
    out: result.out,
    sha: head.sha,
    dirty: head.dirty,
  };
}

/* ── what it becomes on the card ─────────────────────────── */

export const verificationOf = (r, at) => ({
  check: r.name,
  argv: r.argv,
  exit: r.exit ?? null,
  ok: r.ok,
  at,
  sha: r.sha ?? null,
  dirty: !!r.dirty,
  ms: Number.isInteger(r.ms) ? r.ms : 0,
  ...(r.state === 'timeout' ? { timedOut: true } : {}),
});

// The sentence that goes in the note. Every branch names the tree it is talking
// about, because evidence without a sha is a claim about a moment nobody can
// find again — and a pass over a dirty tree says so in the same breath, rather
// than letting the sha imply a cleanliness it did not have.
export function verdictText(r, { cmd }) {
  if (!r.ran) return `Unverified — ${r.reason}. done() proved nothing about this work.`;
  const where = r.sha ? `at ${r.sha}${r.dirty ? ' with uncommitted changes in the tree, so this is not reproducible from the sha alone' : ''}` : 'at an unknown commit — git could not be read';
  switch (r.state) {
    case 'pass':
      return `Check "${r.name}" (${cmd}) passed ${where}, in ${r.ms}ms. That is what it proves: this command exited zero on this tree, not that the work is correct.`;
    case 'fail':
      return `Check "${r.name}" (${cmd}) FAILED ${where} — exit ${r.exit}, ${r.ms}ms. The card stays in progress. Output:\n${r.out || '(no output)'}`;
    case 'timeout':
      return `Check "${r.name}" (${cmd}) was killed after ${r.ms}ms without finishing ${where}. That is an absence of evidence, not a failure and not a pass. Output so far:\n${r.out || '(no output)'}`;
    default:
      return `Check "${r.name}" (${cmd}) could not be run ${where}: ${r.out || 'spawn failed'}. Nothing was proved.`;
  }
}

// A failing check writes a finding, a passing one writes evidence, and a run
// that could not happen writes a finding too — because "we do not know" is
// something a future session must be able to see, and evidence is the one kind
// standup marks PERISHABLE.
export const kindFor = (r) => (r.ran && r.state === 'pass' ? 'evidence' : 'finding');

export const cmdOf = (argv) => (Array.isArray(argv) ? argv.join(' ') : '');
