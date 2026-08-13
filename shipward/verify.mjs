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

// SW-056. How long the streams get to finish draining after the process itself
// has ended. Resolving on 'exit' is what makes the timeout a real bound, and it
// is also how trailing output gets lost — that output is the whole of what a
// human reads when a check fails, so a resolve that outran it would trade a hung
// reply for a silently truncated one.
//
// Measured before choosing, because the risk is not where it looks: a lone child
// that closes its own pipes hands over every byte before 'exit' fires — 100 to
// 1,000,000, ten runs each, nothing late — so the ordinary path never spends
// this. What it buys is the case where something the check LEFT BEHIND still
// holds the pipe with a line yet to write, which a bare exit-resolve lost in
// every one of 12 runs. Whichever event arrives first wins, so this is a
// ceiling on the wait and not the wait itself.
//
// Raised 250 → 1000 by SW-070, and the reason is worth keeping because it says
// what "measured" was worth. Every measurement above was taken on an 8-core
// laptop, where it held even under deliberate saturation — 0/20 lost with 12
// spinners running. The first GitHub ubuntu runner to see it, 2 cores running
// four test workers, dropped a trailing stderr line on its very first job.
//
// The raise is close to free: on the ordinary path 'close' resolves first and
// this timer never fires, so the extra 750ms is only ever paid when an orphan
// really is holding the pipe — the pathological case the bound exists for, on a
// check that has already run for seconds. What it buys is margin on every slow
// or contended machine a real user might have, and the tail of a check's output
// is the summary a human reads when it fails.
//
// The bound itself stays. SW-056 chose a bounded truncation over an unbounded
// hang, and that trade is unchanged: on a starved enough machine a last line can
// still be lost. Wider margin, same promise.
export const OUTPUT_GRACE_MS = 1000;

// SW-060. Every number in the kill path used to be wall clock, and a closed
// laptop lid made all of them lies — twice, both diagnosed via pmset:
//
//   Jul 31  recorded "killed after 1110053ms" against a 120000ms budget.
//           Clamshell Sleep at 16:16:25, asleep 1064s, DarkWake 16:34:19;
//           the check had actually RUN for about 46 seconds.
//   Aug 1   ms=1057254; asleep 964s; the deadline expired mid-sleep and the
//           kill landed the instant the machine woke — on a check ~93s into
//           its 120s budget.
//
// Two distinct wrongs, one cause. The recorded duration counted the sleep and
// went into the card note as memory, where "18.5 minutes against a 120s
// budget" reads as an accusation against the timeout — it already sent one
// root-cause hunt in exactly the wrong direction (see the SW-056 comment on
// killGroup). And setTimeout is a wall-clock appointment, so a sleep that
// outlives the deadline turns wake into an execution.
//
// No clock is trusted to know better. performance.now()/process.hrtime bind
// to whatever source libuv picked — on macOS, mach_absolute_time does not
// advance during sleep, mach_continuous_time does, libuv has changed sources
// across versions and once shipped a wake clock that jumped BACKWARDS
// (libuv#2891) — and none of that is verifiable here, because no test can put
// the machine to sleep. What CAN be observed from inside is absence: a
// heartbeat that stopped beating. A 1s interval records when it actually
// fired; any gap between beats far above the interval is time this process
// was not running, and that time is subtracted before anything is reported
// or killed.
export const TICK_MS = 1000;

// A gap only counts once it dwarfs the beat. A loaded event loop misses by
// tens or hundreds of milliseconds; the two real sleeps missed by 1064000 and
// 964000. Five seconds sits three orders of magnitude from both neighbours,
// so neither can drift into the other. Starvation that long is treated as
// sleep on purpose: for the check's budget they are the same fact — the
// process was not running — and they deserve the same mercy.
export const SUSPEND_GAP_MS = 5000;

// Floor for the absolute wall-clock ceiling; the whole rationale is on
// wallCapOf below.
export const WALL_CAP_FLOOR_MS = 60 * 60 * 1000;

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

// SW-060, the sleep ledger. `ticks` is the heartbeat record — ticks[0] is
// when the run began, every later entry is when the 1s interval actually
// fired — and `now` is the moment being judged, counted as one more beat so
// a deadline that fires before the first post-wake beat still sees the gap
// (Jul 31's did: it came due 18 minutes stale, at the instant of DarkWake).
//
// Each counted gap forfeits one TICK_MS as presumed running time, so this
// UNDER-counts suspension by up to a beat per gap rather than ever crediting
// the check with running time it did not get. A clock that steps backwards
// (libuv#2891 was a wake bug of exactly that shape; NTP corrections too)
// makes a negative gap, which counts as nothing.
export function suspendedMsOf(ticks, now, { tickMs = TICK_MS, gapMs = SUSPEND_GAP_MS } = {}) {
  if (!Array.isArray(ticks) || ticks.length === 0) return 0;
  let suspended = 0;
  let prev = ticks[0];
  for (const t of [...ticks.slice(1), now]) {
    const gap = t - prev;
    if (gap >= gapMs) suspended += gap - tickMs;
    prev = t;
  }
  return suspended;
}

// The mercy has to have an end, or SW-056 comes back through a new door: a
// machine that thrashes so hard EVERY beat gap crosses the threshold banks
// nearly everything as suspension, running time never reaches the budget, and
// a deadline with no ceiling re-arms forever — the exact unbounded reply the
// group kill just closed. So the ceiling is absolute wall clock, sleep
// included, and deliberately consults nothing the gap detector says.
//
// The value: max(4 x timeoutMs, one hour). 4x scales for projects that
// declare long budgets, so a check allowed 30 minutes may also ride out a
// sleep in proportion. The one-hour floor is set by the incidents: both real
// sleeps were ~16-18 minutes against the 2-minute default budget, so a bare
// 4x (8 minutes of wall) would have re-killed at wake the exact two checks
// this fix exists to spare. An hour clears them threefold — a lid closed
// across lunch comes back to a live check — while a lid closed overnight
// still gets a bounded, honestly-worded kill: past that point, proving to
// whoever is still holding the reply open that it ENDS outranks the verdict.
export const wallCapOf = (timeoutMs) => Math.max(4 * timeoutMs, WALL_CAP_FLOOR_MS);

// What the deadline decides when it fires, pure so the incidents can replay
// in tests as synthetic tick histories — no test can close the lid. Three
// outcomes:
//  - running budget spent: kill, the honest timeout.
//  - wall ceiling crossed: kill regardless and say it GAVE UP — see wallCapOf.
//  - neither: spare it, and re-arm for the unused running budget. The re-arm
//    is structural containment in itself: each new wall deadline sits at
//    exactly timeoutMs + suspendedMs as known at that arm (elapsed + the
//    remainder), so wall time never outruns what the recorded beats justify,
//    and the arm is clamped to the ceiling so no fire can land past it.
export function deadlineVerdict({ ticks, now, timeoutMs, wallCapMs, tickMs = TICK_MS, gapMs = SUSPEND_GAP_MS }) {
  const suspendedMs = suspendedMsOf(ticks, now, { tickMs, gapMs });
  const startedAt = Array.isArray(ticks) && ticks.length > 0 ? ticks[0] : now;
  const elapsedMs = Math.max(0, now - startedAt);
  const runningMs = Math.max(0, elapsedMs - suspendedMs);
  if (elapsedMs >= wallCapMs) return { kill: true, gaveUp: true, runningMs, suspendedMs, elapsedMs };
  if (runningMs >= timeoutMs) return { kill: true, gaveUp: false, runningMs, suspendedMs, elapsedMs };
  return {
    kill: false, gaveUp: false, runningMs, suspendedMs, elapsedMs,
    rearmMs: Math.max(1, Math.min(timeoutMs - runningMs, wallCapMs - elapsedMs)),
  };
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

// SW-056. child.kill() signals the DIRECT child and nothing it spawned, so a
// check that leaves anything behind was never bounded by its timeout: the
// survivor holds the inherited stdout open, and 'close' waits on IT rather
// than on the check. Signalling the GROUP is the only reason spawnCheck asks
// for `detached: true`. (The wild "killed after 1110053ms" this card first
// pinned on an orphan turned out, via pmset, to be the laptop lid — that
// re-diagnosis is SW-060, and it is what a duration that counts sleep costs.
// The orphan hazard is real all the same: reproduced and measured in the
// tests, and the group kill is what bounds it.)
//
// Measured, since the card blamed `node --test` workers specifically and that
// part does not hold on Node 25: the runner forwards SIGTERM to its own workers,
// so a merely slow suite already died on time. What survives is anything one
// level further out — a suite that spawns, or a wrapper like npm or sh passing
// our stdio down — which is a wider class than the report described, not a
// narrower one.
const killGroup = (child, signal) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // A group that is already gone is the outcome we wanted, not a failure to
    // report — and process.kill throws ESRCH for it, so a timeout that raced the
    // child's own exit would crash the server instead of bounding a check.
    // Anything else (EPERM, or a platform that gave us no group) still deserves
    // the direct child, so fall through rather than give up on the kill.
    try { child.kill(signal); } catch { /* the child is gone too; nothing left to stop */ }
  }
};

// No shell, ever. argv[0] is the program and the rest are arguments, so nothing
// in a check is parsed as syntax — see the validator in tracker-store.mjs,
// which refuses a check that is not an argv array at the write.
export function spawnCheck(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd, env: checkEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, purely so the timeout has something to kill
        // that includes the grandchildren. Not for backgrounding: nothing here
        // unrefs the child, and stdin is 'ignore', so the usual detached hazards
        // (a stray SIGTTIN, a parent that exits early) do not apply. The one
        // real cost is that a terminal's Ctrl-C no longer reaches the check —
        // the parent dying breaks its stdout instead.
        detached: true,
      });
    } catch (err) {
      resolve({ exit: null, ms: 0, out: String(err.message || err), spawnError: true });
      return;
    }
    let out = '';
    let timedOut = false;
    let gaveUp = false;
    // Bounded in memory too, not merely in what we keep: a runaway process that
    // prints for two minutes should not be buffered in full first.
    const take = (buf) => { if (out.length < OUTPUT_BUDGET * 8) out += buf; };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    // SW-060: the heartbeat. Its only job is to leave a record of when this
    // process was actually running; suspendedMsOf reads the gaps in it.
    // Cleared in finish() with the other timers — an interval left beating
    // would hold this event loop open on a check that has already been
    // answered, which is the SW-056 hang wearing a new face.
    const ticks = [started];
    const heartbeat = setInterval(() => ticks.push(Date.now()), TICK_MS);
    const wallCapMs = wallCapOf(timeoutMs);

    let escalation = null;
    let deadline = null;
    // SW-060: the deadline no longer trusts its own punctuality. It may fire
    // minutes late because the machine slept through the appointment — Aug 1's
    // fired at the instant of DarkWake, 937s stale, onto a check ~93s into a
    // 120s budget — so before killing anything it asks deadlineVerdict how
    // much of the elapsed wall was RUNNING time, and re-arms for the unused
    // budget when the answer is "not enough to die for".
    const onDeadline = () => {
      const verdict = deadlineVerdict({ ticks, now: Date.now(), timeoutMs, wallCapMs });
      if (!verdict.kill) {
        deadline = setTimeout(onDeadline, verdict.rearmMs);
        return;
      }
      timedOut = true;
      gaveUp = verdict.gaveUp;
      killGroup(child, 'SIGTERM');
      // A child that ignores SIGTERM would otherwise hold the reply open past
      // the timeout that exists to bound it.
      escalation = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
      escalation.unref?.();
    };
    deadline = setTimeout(onDeadline, timeoutMs);

    let grace = null;
    let settled = false;
    const finish = (exit, spawnError = false) => {
      // 'exit' and 'close' both land on the ordinary path, and a SIGKILL
      // escalation can arrive after either.
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      clearTimeout(escalation);
      clearInterval(heartbeat);
      // An orphan can hold these pipes open forever. Leaving them readable would
      // keep this process's event loop alive on a check that has already been
      // answered — the hang moved rather than fixed.
      child.stdout?.destroy();
      child.stderr?.destroy();
      // SW-060: ms is RUNNING time — wall minus every detected suspension. The
      // wall figure went into a card note once as "killed after 1110053ms" and
      // was believed; a duration that counts the sleep is not a duration, it
      // is an alibi for the wrong suspect. suspendedMs appears only when a gap
      // actually crossed the threshold, so the ordinary result is unchanged.
      const now = Date.now();
      const suspendedMs = suspendedMsOf(ticks, now);
      resolve({
        exit, ms: Math.max(0, now - started - suspendedMs), out: clip(out), timedOut, spawnError,
        ...(suspendedMs > 0 ? { suspendedMs } : {}),
        ...(gaveUp ? { gaveUp: true } : {}),
      });
    };

    // 'close' waits for the stdio streams to reach EOF, which is a fact about
    // whoever still holds the pipe and not about whether the process we timed is
    // over. So 'exit' decides the outcome and starts a short bounded wait for
    // the rest of the output; 'close' inside that window resolves immediately
    // with everything. The two halves of SW-056 are not alternatives — the group
    // kill without this still waits on a pipe an unkillable orphan could hold,
    // and this without the group kill answers promptly while the workers run on.
    let exited = false;
    let outcome = null;
    child.on('exit', (code) => {
      exited = true;
      outcome = timedOut ? null : code;
      grace = setTimeout(() => finish(outcome), OUTPUT_GRACE_MS);
    });
    child.on('error', (err) => { out += String(err.message || err); finish(null, true); });
    child.on('close', (code) => finish(exited ? outcome : (timedOut ? null : code)));
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

  // SW-078. The tree is read on BOTH sides of the run, because a single reading
  // before it only ever proved something about a moment that had already
  // passed. Raised by a reader on the day this went public, and he put the
  // invariant better than this project had: the claim worth making is not "this
  // command passed" but "this command passed against the artifact now being
  // marked complete".
  //
  // A check can run for minutes. Anything that lands in the tree meanwhile —
  // the agent editing another file, a build artefact, a second session — was
  // invisible, and the evidence was stamped with pre-run state. So a pass could
  // be recorded against a tree that no longer existed by the time the card
  // moved.
  const head = await headState(cwd);
  const result = await run(resolved.argv, { cwd, timeoutMs: timeoutOf(project) });
  const after = await headState(cwd);
  const outcome = readOutcome(result);

  // Only claimable when both readings succeeded. If git could not be read
  // either side, "did it move?" is unknown — and unknown must not read as no.
  const comparable = head.known && after.known && head.digest && after.digest;
  const moved = comparable && head.digest !== after.digest;

  return {
    ran: true,
    name: resolved.name,
    argv: resolved.argv,
    ...outcome,
    // A tree that moved under the check makes the result unusable as evidence
    // for THIS card, whatever the exit code was — the same class as a timeout:
    // absence of evidence, neither pass nor fail. Overrides the outcome so a
    // green exit cannot carry a card whose ground shifted beneath it.
    ...(moved ? { state: 'moved', ok: false, movedFrom: head.sha, movedTo: after.sha } : {}),
    exit: result.exit,
    ms: result.ms,
    // SW-060: the sleep travels with the result, or verdictText would be back
    // to guessing why 93s of running took 18 minutes of wall.
    ...(result.suspendedMs > 0 ? { suspendedMs: result.suspendedMs } : {}),
    ...(result.gaveUp ? { gaveUp: true } : {}),
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
  ...(r.state === 'moved' ? { treeMoved: true } : {}),
});

// SW-060: said in every outcome where a suspension was detected. The two
// readings this sentence keeps apart send a reader in opposite directions:
// "the machine slept mid-check" sends them to pmset and the lid, "your check
// is slow" sends them to the timeout and the suite. The Jul 31 note implied
// the second when the first was true, and cost a root-cause hunt.
const sleptClause = (r) => (r.suspendedMs > 0
  ? ` The machine slept ${Math.round(r.suspendedMs / 1000)}s mid-check (or the process was starved that long — the same fact for this budget); that time is not counted in the ${r.ms}ms.`
  : '');

// The sentence that goes in the note. Every branch names the tree it is talking
// about, because evidence without a sha is a claim about a moment nobody can
// find again — and a pass over a dirty tree says so in the same breath, rather
// than letting the sha imply a cleanliness it did not have.
export function verdictText(r, { cmd }) {
  if (!r.ran) return `Unverified — ${r.reason}. done() proved nothing about this work.`;
  const where = r.sha ? `at ${r.sha}${r.dirty ? ' with uncommitted changes in the tree, so this is not reproducible from the sha alone' : ''}` : 'at an unknown commit — git could not be read';
  switch (r.state) {
    case 'pass': {
      const proof = `Check "${r.name}" (${cmd}) passed ${where}, in ${r.ms}ms.${sleptClause(r)} That is what it proves: this command exited zero on this tree, not that the work is correct.`;
      // SW-079. A pass normally keeps no transcript: the note is memory every
      // future session re-reads, a full test log is a cost paid forever, and a
      // green run at a clean sha is re-derivable by checking out that sha and
      // running the same argv. That argument fails in exactly one case — a
      // DIRTY tree, where the sha does not describe what was tested and the
      // transcript is the only record there will ever be. Raised by a reader,
      // and right.
      return r.dirty ? `${proof} The tree was dirty, so this is the only record of what ran:\n${r.out || '(no output)'}` : proof;
    }
    case 'moved': {
      // Most of the time the sha is IDENTICAL on both sides — the change was in
      // the working tree, not a commit. Printing "abc123 before, abc123 after"
      // reads as a bug in the tool rather than as a fact about the repo, so the
      // two cases are worded differently.
      const how = r.movedFrom && r.movedTo && r.movedFrom !== r.movedTo
        ? `HEAD moved from ${r.movedFrom} to ${r.movedTo} while it ran`
        : `the working tree changed while it ran${r.movedFrom ? ` (still at ${r.movedFrom})` : ''}`;
      return `Check "${r.name}" (${cmd}) ran, but ${how}. Whatever it exited with, it did not test the tree this card is being marked complete against, so it proves nothing about this hand-back — that is an absence of evidence, not a failure and not a pass. The card stays in progress. Commit or stash, then run done() again. Output:\n${r.out || '(no output)'}`;
    }
    case 'fail':
      return `Check "${r.name}" (${cmd}) FAILED ${where} — exit ${r.exit}, ${r.ms}ms.${sleptClause(r)} The card stays in progress. Output:\n${r.out || '(no output)'}`;
    case 'timeout':
      // gaveUp is the wall ceiling, and the check is NOT charged as slow: it
      // never received its budget of running time — the machine would not stay
      // awake long enough to grant it (see wallCapOf).
      if (r.gaveUp) {
        return `Check "${r.name}" (${cmd}) was killed ${where} after the machine slept ${Math.round((r.suspendedMs || 0) / 1000)}s mid-check: the check itself had run for only ${r.ms}ms, but total wall time crossed the hard ceiling, so the runner gave up waiting for the machine to stay awake. Blame the sleeping machine, not the check's speed. That is an absence of evidence, not a failure and not a pass. Output so far:\n${r.out || '(no output)'}`;
      }
      return `Check "${r.name}" (${cmd}) was killed after ${r.ms}ms of running time without finishing ${where}.${sleptClause(r)} That is an absence of evidence, not a failure and not a pass. Output so far:\n${r.out || '(no output)'}`;
    default:
      return `Check "${r.name}" (${cmd}) could not be run ${where}: ${r.out || 'spawn failed'}. Nothing was proved.`;
  }
}

// A failing check writes a finding, a passing one writes evidence, and a run
// that could not happen writes a finding too — because "we do not know" is
// something a future session must be able to see, and evidence is the one kind
// standup marks PERISHABLE.
// Only a pass is evidence. Everything else — failed, timed out, could not spawn,
// or ran against a tree that moved underneath it (SW-078) — is a finding.
export const kindFor = (r) => (r.ran && r.state === 'pass' ? 'evidence' : 'finding');

export const cmdOf = (argv) => (Array.isArray(argv) ? argv.join(' ') : '');
