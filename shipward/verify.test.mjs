// Verification gating tests. Run: node --test
//
// SW-043. The rules are pure and get exercised exhaustively without spawning
// anything; the spawn and the git read get real processes and one throwaway
// repository, because a mock of spawn would only prove I can predict spawn —
// and spawn's behaviour is the thing being relied on for safety here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCheck, timeoutOf, clip, readOutcome, kindFor, verdictText,
  spawnCheck, runCheck, verificationOf, cmdOf,
  DEFAULT_TIMEOUT_MS, OUTPUT_BUDGET, checkEnv, CHECK_TRACKER,
  suspendedMsOf, deadlineVerdict, wallCapOf, WALL_CAP_FLOOR_MS,
} from './verify.mjs';
import { headState } from './git.mjs';
import { verifyMsg } from './public/lib.js';

const run = promisify(execFile);

const project = (over = {}) => ({ id: 'test', name: 'Test', prefix: 'TS', ...over });
const card = (over = {}) => ({ id: 'TS-001', p: 'test', title: 'a card', ...over });

const repo = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-verify-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-qm', 'first'], { cwd: dir });
  return dir;
};

/* ── resolution: a card selects, it never defines ────────── */

test('a card names a check and the project declares it', () => {
  const r = resolveCheck(project({ checks: { unit: ['node', '--test'] } }), card({ check: 'unit' }));
  assert.deepEqual(r.argv, ['node', '--test']);
  assert.equal(r.name, 'unit');
});

test('a card with no check falls back to the project default', () => {
  const r = resolveCheck(project({ checks: { default: ['node', '-v'] } }), card());
  assert.equal(r.name, 'default');
  assert.deepEqual(r.argv, ['node', '-v']);
});

test('a name the project does not declare resolves to nothing executable, and says which name', () => {
  const r = resolveCheck(project({ checks: { unit: ['node', '-v'] } }), card({ check: 'typo' }));
  assert.equal(r.argv, null);
  assert.match(r.reason, /"typo"/, 'the reply must name the check that is missing, or a typo is unfindable');
});

test('a project declaring nothing promises nothing', () => {
  const r = resolveCheck(project(), card());
  assert.equal(r.argv, null);
  assert.equal(r.name, null, 'no name means nothing was promised — distinct from a name that resolves to nothing');
});

// The security property this whole design exists to hold. The tracker is
// written by an agent and by an unauthenticated PUT; if a card could carry a
// command, writing the file would be writing an exec.
test('a card carrying a command instead of a name executes nothing', () => {
  for (const hostile of [
    ['rm', '-rf', '/'],
    'rm -rf /',
    { argv: ['rm', '-rf', '/'] },
  ]) {
    const r = resolveCheck(project({ checks: { default: ['node', '-v'] } }), card({ check: hostile }));
    assert.equal(r.argv, null, `a card check of ${JSON.stringify(hostile)} must resolve to nothing`);
  }
});

test('an empty argv is not a check', () => {
  assert.equal(resolveCheck(project({ checks: { default: [] } }), card()).argv, null);
});

test('the timeout is the project\'s when it declares a sane one, and the default otherwise', () => {
  assert.equal(timeoutOf(project({ checkTimeoutMs: 5000 })), 5000);
  for (const bad of [0, -1, 1.5, '5000', null, undefined]) {
    assert.equal(timeoutOf(project({ checkTimeoutMs: bad })), DEFAULT_TIMEOUT_MS);
  }
});

/* ── reading an outcome ──────────────────────────────────── */

test('exit zero passes, anything else fails', () => {
  assert.equal(readOutcome({ exit: 0 }).state, 'pass');
  assert.equal(readOutcome({ exit: 0 }).ok, true);
  for (const exit of [1, 2, 127, null]) assert.equal(readOutcome({ exit }).ok, false);
});

test('a timeout outranks the exit code it raced with', () => {
  // The kill can land after the child has already exited zero. Reading the exit
  // code first would report a pass for a check that never finished.
  const r = readOutcome({ exit: 0, timedOut: true });
  assert.equal(r.state, 'timeout');
  assert.equal(r.ok, false);
});

test('a spawn failure is not a test failure', () => {
  assert.equal(readOutcome({ exit: null, spawnError: true }).state, 'error');
});

test('only a pass is filed as evidence', () => {
  assert.equal(kindFor({ ran: true, state: 'pass' }), 'evidence');
  for (const state of ['fail', 'timeout', 'error']) {
    assert.equal(kindFor({ ran: true, state }), 'finding', `${state} is a finding, not evidence`);
  }
  assert.equal(kindFor({ ran: false }), 'finding');
});

/* ── what the note says ──────────────────────────────────── */

test('a pass names the sha and refuses to claim the work is correct', () => {
  const text = verdictText(
    { ran: true, state: 'pass', name: 'unit', sha: 'abc1234', dirty: false, ms: 12 },
    { cmd: 'node --test' },
  );
  assert.match(text, /abc1234/);
  assert.match(text, /not that the work is correct/);
});

test('a pass over a dirty tree says so in the same breath as the sha', () => {
  const text = verdictText(
    { ran: true, state: 'pass', name: 'unit', sha: 'abc1234', dirty: true, ms: 12 },
    { cmd: 'x' },
  );
  assert.match(text, /uncommitted/);
  assert.match(text, /not reproducible/);
});

test('a failure carries the exit code and the output', () => {
  const text = verdictText(
    { ran: true, state: 'fail', name: 'unit', exit: 3, sha: 'abc1234', ms: 9, out: 'boom' },
    { cmd: 'x' },
  );
  assert.match(text, /exit 3/);
  assert.match(text, /boom/);
});

test('a timeout is neither a pass nor a failure', () => {
  const text = verdictText({ ran: true, state: 'timeout', name: 'u', sha: null, ms: 100, out: '' }, { cmd: 'x' });
  assert.match(text, /absence of evidence/);
  assert.doesNotMatch(text, /passed/);
});

test('nothing run says plainly that nothing was proved', () => {
  const text = verdictText({ ran: false, reason: 'no check declared' }, { cmd: '' });
  assert.match(text, /proved nothing/);
});

test('a feed line for a held card never claims a move', () => {
  for (const state of ['fail', 'timeout', 'error', 'unresolved']) {
    const msg = verifyMsg('TS-001', state);
    assert.doesNotMatch(msg, /Review|moved/i, `"${msg}" would read as a promotion that did not happen`);
  }
  assert.match(verifyMsg('TS-001', 'fail', { forced: true }), /override/);
});

/* ── clipping ────────────────────────────────────────────── */

test('output under budget is untouched', () => {
  assert.equal(clip('short'), 'short');
});

test('output over budget keeps both ends and states the cut', () => {
  const long = `HEAD${'x'.repeat(9000)}TAIL`;
  const out = clip(long, 400);
  assert.ok(out.length < long.length);
  assert.match(out, /^HEAD/, 'the head is where the failure usually is');
  assert.match(out, /TAIL$/, 'the tail is where the summary usually is');
  assert.match(out, /elided/, 'a silent clip is how a reader comes to believe they saw it all');
});

/* ── measuring time on a machine that may not have any ───── */
// SW-065. Two tests below are wall-clock races: one against OUTPUT_GRACE_MS
// (250ms), one against a process being scheduled at all. On a contended box
// neither can be measured — a no-op spawn there costs more than the whole
// window — and both then fail for reasons that have nothing to do with the
// product. Four of eight full-suite runs failed that way before this existed.
//
// A blanket relaxation would hide the regressions they exist to catch, so
// instead the machine is measured first and the tests say plainly when it is
// too busy to be measured on. On any ordinary machine the probe is tens of
// milliseconds and the assertions run at full strength.
const PROBE_CEILING_MS = 1500;

async function tooBusyToTime() {
  const started = Date.now();
  await spawnCheck([process.execPath, '-e', ''], { cwd: process.cwd(), timeoutMs: 30000 });
  const probe = Date.now() - started;
  return probe > PROBE_CEILING_MS ? probe : null;
}

/* ── the spawn itself ────────────────────────────────────── */

test('a passing command reports exit zero and its output', async () => {
  const r = await spawnCheck(['node', '-e', 'console.log("hello")'], { cwd: process.cwd(), timeoutMs: 10000 });
  assert.equal(r.exit, 0);
  assert.match(r.out, /hello/);
  assert.equal(r.timedOut, false);
});

test('a failing command reports its code and its stderr', async () => {
  const r = await spawnCheck(
    ['node', '-e', 'console.error("nope"); process.exit(3)'],
    { cwd: process.cwd(), timeoutMs: 10000 },
  );
  assert.equal(r.exit, 3);
  assert.match(r.out, /nope/);
});

test('a command that will not finish is killed and reported as a timeout', async () => {
  const started = Date.now();
  const r = await spawnCheck(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'the timeout must bound the wait, not merely be recorded');
});

// SW-056. The test above passes on the broken code, and that is the finding: a
// lone sleeping process closes its own pipes when it dies, so 'close' arrives
// promptly and the bound looks held. The check this project recommends to every
// repo is `node --test`, which runs its files in WORKER processes — and a worker
// that survives a kill aimed only at the runner keeps the INHERITED stdout open,
// so 'close' is waiting on the orphan rather than on the check. (The wild
// "killed after 1110053ms" this card first blamed on an orphan was later
// re-diagnosed via pmset as the laptop lid — SW-060 — which is what a duration
// that counts sleep costs. The orphan hazard is real regardless, and this test
// reproduces it.)
test('the timeout bounds the run even when the check leaves a grandchild holding its stdout', async (t) => {
  const busy = await tooBusyToTime();
  if (busy) return t.skip(`machine too contended to time a spawn (no-op probe took ${busy}ms) — this test measures scheduling, and cannot on a box this busy`);
  const dir = await mkdtemp(join(tmpdir(), 'shipward-orphan-'));
  try {
    const pidFile = join(dir, 'grandchild.pid');
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`
      + ` setTimeout(() => {}, 30000);`;
    // stdio inherit is the whole point: the grandchild holds the very pipe
    // spawnCheck is reading, exactly as a test worker does.
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],`
      + ` { stdio: ['ignore', 'inherit', 'inherit'] }); setTimeout(() => {}, 30000);`;

    // 3000, not 1000 (SW-065). The scenario needs a grandchild that is ALIVE and
    // holding the pipe when the timeout fires — and on a saturated box a freshly
    // spawned node process does not always get scheduled within a second, so the
    // kill landed before it had written its pid and the fixture could no longer
    // set up the condition it exists to test. Three seconds buys the setup
    // without touching the property: the run must still be bounded by this
    // timeout rather than by the grandchild's 30000ms life.
    const started = Date.now();
    const r = await spawnCheck([process.execPath, '-e', parent], { cwd: dir, timeoutMs: 3000 });
    const elapsed = Date.now() - started;

    assert.equal(r.timedOut, true);
    // The question is whether the run was bounded by the 1000ms timeout or by
    // the grandchild's 30000ms life, so the ceiling only has to separate those
    // two answers. It used to be 6000, which on a loaded box was not measuring
    // the bound at all — it was measuring how long three node processes took to
    // start (SW-065: two of four full-suite runs failed here while a 13-agent
    // job ran, and every one of them passed alone). Half the grandchild's life
    // still fails loudly if the bound breaks, and cannot be crossed by load.
    assert.ok(elapsed < 15000,
      `the run must be bounded by the 3000ms timeout, not by the grandchild's 30000ms life — took ${elapsed}ms`);

    // Wait for the grandchild to announce itself before reading the file it
    // writes. Reading immediately is a race the fixture loses under load — the
    // timeout fires at 1000ms whether or not a descheduled process has got as
    // far as its first write, and the test then died on ENOENT rather than on
    // anything about the product (SW-065). If it never appears, say which of
    // the two things went wrong rather than throwing a filesystem error.
    let pidRaw = null;
    for (let i = 0; i < 500 && pidRaw === null; i++) {
      pidRaw = await readFile(pidFile, 'utf8').catch(() => null);
      if (pidRaw === null) await new Promise((done) => setTimeout(done, 20));
    }
    assert.ok(pidRaw, 'the grandchild never recorded its pid — it was killed before it started, or never spawned');

    // Answering promptly while the workers keep running is the half-fix: the
    // CPU burns invisibly, behind a reply that already said the check was over.
    // The budget here is generous for the same reason: a signal that lands and
    // a process that is descheduled look identical for as long as the box is
    // busy, and only the first is a bug.
    const gpid = Number(pidRaw);
    let alive = true;
    for (let i = 0; i < 500 && alive; i++) {
      try { process.kill(gpid, 0); await new Promise((done) => setTimeout(done, 20)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the orphaned grandchild must be killed with the group, not left running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The other half of SW-056, and the part with a trap in it. Resolving on 'exit'
// is what makes the timeout a bound, and it is also how trailing output gets
// lost — that output IS the note a human reads when a check fails, so trading a
// hung reply for a silently truncated one would be no trade at all. Two tests,
// because the risk is not where it looks.
//
// Measured first: for a lone child that closes its own pipes, every byte from
// 100 to 1,000,000 arrived before 'exit' fired, 10 runs at each size. So this
// one passes with or without the grace window. It stays as the guard on the
// path every check actually takes.
test('output written right up to exit is not lost on the ordinary path', async () => {
  const src = `for (let i = 0; i < 300; i++) console.log('line ' + i);`
    + ` console.error('LAST-LINE'); process.exitCode = 7;`;
  const r = await spawnCheck([process.execPath, '-e', src], { cwd: process.cwd(), timeoutMs: 10000 });
  assert.equal(r.exit, 7);
  assert.equal(r.timedOut, false);
  assert.match(r.out, /line 0/, 'the head is where the failure usually is');
  assert.match(r.out, /LAST-LINE/, 'the tail is where the summary usually is');
});

// And this is the one the grace window exists for, measured 12/12 lost without
// it and 12/12 kept with it. The check process ends while something it left
// behind still holds the inherited pipe and has not written its last line yet —
// a runner whose worker reports after it. Resolving the instant 'exit' fires
// keeps "BEFORE" and drops the rest, which is the truncation that would make the
// bound a bad trade rather than a fix.
test('a line written after the check process is already gone still reaches the note', async (t) => {
  const busy = await tooBusyToTime();
  if (busy) return t.skip(`machine too contended to time a 250ms window (no-op probe took ${busy}ms)`);
  // fd 3 is a leash, not a channel: the worker never reads anything down it, it
  // only gets EOF at the instant the check process dies, so the write is pinned
  // to just after 'exit' without a sleep anyone has to tune against machine
  // load. Polling for the parent to disappear was the obvious fixture and it is
  // not reliable — under load some workers never noticed at all and leaked.
  // Writes the instant the leash breaks, with no timer of its own. The 15ms
  // delay this used to carry was spending the product's 250ms grace window on
  // the fixture: under load that 15ms stretched past the window, the line was
  // legitimately dropped, and the test failed for doing exactly what it
  // promises (SW-065). Writing immediately still happens strictly after the
  // check process is gone — which is the whole property — and leaves the entire
  // window for the thing being measured.
  const worker = `const { Socket } = require('node:net');
    const leash = new Socket({ fd: 3, readable: true, writable: false });
    leash.on('end', () => { process.stdout.write('WROTE-AFTER-EXIT'); process.exit(0); });
    leash.resume();`;
  const src = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}],`
    + ` { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });`
    // Both unrefs, or the check cannot finish ahead of the worker it spawned —
    // the child handle AND the leash each hold its event loop open.
    + ` c.unref(); c.stdio[3].unref();`
    + ` process.stdout.write('BEFORE'); setTimeout(() => {}, 300);`;

  // Best of five, deliberately (SW-065). The grace window is a 250ms CEILING on
  // how long the run will wait for trailing output — not a promise that a
  // descheduled process will produce it in time. On a saturated box the write
  // can legitimately land after the window closes, and the product is then
  // doing exactly what it says. Asserting on a single attempt made that correct
  // behaviour look like a regression. What is actually claimed, and what this
  // proves, is that the window CAN catch a post-exit line — so one success is
  // the evidence, and five attempts is the budget for finding it.
  let kept = 0;
  let sawBefore = 0;
  for (let attempt = 0; attempt < 5 && kept === 0; attempt++) {
    const r = await spawnCheck([process.execPath, '-e', src], { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(r.exit, 0);
    assert.equal(r.timedOut, false, 'this is the ordinary path — nothing here should be killed');
    if (/BEFORE/.test(r.out)) sawBefore++;
    if (/WROTE-AFTER-EXIT/.test(r.out)) kept++;
  }
  assert.ok(sawBefore > 0, 'output written before exit must never be lost — that is not the grace window, that is the pipe');
  assert.ok(kept > 0,
    'in five attempts the grace window never once kept a line written after the process ended — '
    + 'resolving the instant exit fires drops whatever the streams had not handed over yet');
});

test('a program that does not exist is an error, not a throw', async () => {
  const r = await spawnCheck(['definitely-not-a-program-xyz'], { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(r.spawnError, true);
  assert.equal(r.exit, null);
});

// No shell means shell syntax is not syntax — it is just a filename that does
// not exist. This is the belt that makes a hostile checks map inert.
test('shell metacharacters are not interpreted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-shell-'));
  try {
    const r = await spawnCheck([`echo hi > ${join(dir, 'pwned')}`], { cwd: dir, timeoutMs: 5000 });
    assert.equal(r.spawnError, true);
    await assert.rejects(stat(join(dir, 'pwned')), 'the redirect must not have been honoured by a shell');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── sleep is not running time (SW-060) ──────────────────── */
//
// Two real kills, both the laptop lid, both diagnosed via pmset. Jul 31: a
// check on a 120000ms budget recorded as "killed after 1110053ms" — Clamshell
// Sleep held 1064s of that, about 46s was actual running. Aug 1: ms=1057254,
// asleep 964s, killed at the instant of DarkWake with ~93s of its budget
// used. No test can close the lid, which is exactly why the accounting is
// pure: the incidents replay here as synthetic tick histories.

const beats = (from, to, step = 1000) => {
  const a = [];
  for (let t = from; t <= to; t += step) a.push(t);
  return a;
};

test('a run with ordinary beats accumulates no suspension', () => {
  assert.equal(suspendedMsOf(beats(0, 10000), 10400), 0);
});

test('starvation below the threshold is running time, not sleep', () => {
  // A loaded event loop misses beats by hundreds of ms, occasionally seconds.
  // Crediting those as sleep would quietly stretch every budget on a busy box.
  assert.equal(suspendedMsOf([0, 4900, 9800], 14000), 0);
  assert.equal(suspendedMsOf([0, 4999], 5999), 0, 'just under the line is still running time');
  assert.equal(suspendedMsOf([0, 5000], 6000), 4000, 'at the line it counts, minus the one beat it displaced');
});

test('one long gap is suspension, and the accounting under-counts it by design', () => {
  // 964000 is the Aug 1 sleep. Forfeiting one TICK_MS per gap means detection
  // may credit up to a beat too little sleep, never a beat too much — the
  // safe direction, since every credited ms extends a kill deadline.
  assert.equal(suspendedMsOf([0, 1000, 2000], 2000 + 964000), 963000);
});

test('the gap between the last beat and now counts — a deadline can fire before any post-wake beat', () => {
  // The wake ordering is not guaranteed: the stale deadline can run ahead of
  // the stale heartbeat. `now` is judged as one more beat so the sleep is
  // visible either way.
  assert.equal(suspendedMsOf([0, 1000], 900000), 898000);
});

test('a clock that steps backwards adds no suspension and no negative running time', () => {
  // libuv#2891 was a wake bug of exactly this shape — the hrtime epoch reset
  // after sleep — and NTP corrections do it to wall clocks routinely. Nothing
  // here may assume time only moves forward.
  assert.equal(suspendedMsOf([0, 1000, 500], 1500), 0);
  const v = deadlineVerdict({ ticks: [5000], now: 1000, timeoutMs: 120000, wallCapMs: wallCapOf(120000) });
  assert.equal(v.kill, false);
  assert.equal(v.runningMs, 0);
});

test('Jul 31 replay: the wake-instant deadline spares a check ~46s into a 120s budget', () => {
  // Sleep began ~29s in; the deadline fires at DarkWake, 18 minutes stale in
  // wall terms, before any post-wake beat. The old code killed here.
  const v = deadlineVerdict({
    ticks: beats(0, 29000), now: 29000 + 1064000,
    timeoutMs: 120000, wallCapMs: wallCapOf(120000),
  });
  assert.equal(v.kill, false, 'killing at wake was the bug — 90s of the budget was still unused');
  assert.equal(v.suspendedMs, 1063000);
  assert.equal(v.runningMs, 30000);
  assert.equal(v.rearmMs, 90000, 're-armed for exactly the unused running budget');
});

test('Jul 31 replay: 1110053ms of wall reports as ~47s of running time, not 18.5 minutes', () => {
  // The full history: 29s of beats, the 1064s lid-close, then wake beats until
  // the check finishes at wall 1110053 — the exact ms the incident recorded.
  const ticks = [...beats(0, 29000), ...beats(29000 + 1064000, 1110000)];
  const suspendedMs = suspendedMsOf(ticks, 1110053);
  assert.equal(suspendedMs, 1063000);
  assert.equal(1110053 - suspendedMs, 47053,
    'the note said 18.5 minutes and was believed; the truth was under a minute');
});

test('Aug 1 replay: killed at DarkWake with ~93s of 120s used — now spared and re-armed for the rest', () => {
  const v = deadlineVerdict({
    ticks: beats(0, 91000), now: 91000 + 966254,
    timeoutMs: 120000, wallCapMs: wallCapOf(120000),
  });
  assert.equal(v.kill, false);
  assert.equal(v.runningMs, 92000);
  assert.equal(v.rearmMs, 28000);
});

test('a budget genuinely spent across a sleep still kills — mercy extends the clock, not the budget', () => {
  const ticks = [...beats(0, 60000), ...beats(960000, 1021000)];
  const v = deadlineVerdict({ ticks, now: 1021000, timeoutMs: 120000, wallCapMs: wallCapOf(120000) });
  assert.equal(v.kill, true);
  assert.equal(v.gaveUp, false, 'this is an honest timeout, not the ceiling');
  assert.equal(v.suspendedMs, 899000);
  assert.equal(v.runningMs, 122000);
});

test('the absolute ceiling: a machine that sleeps over and over gets a kill that says it gave up', () => {
  // Five 850s naps with 10s of running between them: 55s of running time —
  // under budget forever — while wall crosses the one-hour cap. Without this
  // rule the deadline would re-arm for as long as the lid keeps closing, and
  // a machine thrashing hard enough to fail every beat would hold the reply
  // open unboundedly: the SW-056 hang through a new door.
  const ticks = [0];
  let t = 0;
  for (let nap = 0; nap < 5; nap++) {
    for (let i = 0; i < 10; i++) ticks.push(t += 1000);
    ticks.push(t += 850000);
  }
  const v = deadlineVerdict({ ticks, now: t, timeoutMs: 120000, wallCapMs: wallCapOf(120000) });
  assert.ok(v.elapsedMs > wallCapOf(120000), `fixture must cross the cap, at ${v.elapsedMs}`);
  assert.equal(v.kill, true);
  assert.equal(v.gaveUp, true);
  assert.ok(v.runningMs < 120000, 'killed with budget to spare — the ceiling speaking, not the timeout');
});

test('a re-arm can never land past the ceiling', () => {
  // Just under the cap with almost all its budget unused: the next arm is
  // clamped to the 1000ms left before the ceiling, not the 119000ms of
  // remaining budget — the ceiling is a fact about the next fire, not a hope.
  const v = deadlineVerdict({ ticks: [0], now: 3599000, timeoutMs: 120000, wallCapMs: 3600000 });
  assert.equal(v.kill, false);
  assert.equal(v.rearmMs, 1000);
});

test('the ceiling scales with declared budgets and never sits below the incident sleeps', () => {
  assert.equal(WALL_CAP_FLOOR_MS, 60 * 60 * 1000);
  assert.equal(wallCapOf(DEFAULT_TIMEOUT_MS), WALL_CAP_FLOOR_MS,
    '4x the default budget is 8 minutes — both real sleeps (1064s, 964s) blew past that, so the floor rules');
  assert.equal(wallCapOf(30 * 60 * 1000), 2 * 60 * 60 * 1000, 'a project declaring 30 minutes gets 4x');
});

test('a check whose host stops running mid-check is spared at wake and billed only for running time', async () => {
  // The lid cannot be closed from a test, but the observable is identical:
  // this process stops running, every timer goes stale, everything fires late
  // together. Atomics.wait blocks the event loop dead for 6s while the child
  // lives on independently — from inside spawnCheck that is a 6s beat gap,
  // the same shape as the 1064s one, just short enough to sit in a suite.
  const t0 = Date.now();
  const pending = spawnCheck(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), timeoutMs: 2000 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  const r = await pending;
  const wall = Date.now() - t0;
  assert.equal(r.timedOut, true, 'the running budget does eventually kill it');
  assert.equal(r.gaveUp, undefined, 'nowhere near the ceiling');
  assert.ok(wall >= 6000, `the stall must actually have happened, wall=${wall}`);
  assert.ok(r.suspendedMs >= 4000, `the 6s stall must be detected as suspension, got ${r.suspendedMs}`);
  assert.ok(r.ms >= 1500, `the check must get its budget of RUNNING time before dying, got ${r.ms}ms`);
  assert.ok(r.ms <= wall - 4000,
    `ms must be running time, not wall — got ${r.ms}ms against ${wall}ms of wall`);
});

test('a timed-out check that slept mid-run blames the lid in the note, not the check', () => {
  const text = verdictText(
    { ran: true, state: 'timeout', name: 'default', sha: 'abc1234', ms: 120001, suspendedMs: 964000, out: '' },
    { cmd: 'node --test' },
  );
  assert.match(text, /slept 964s mid-check/, 'the reader must be sent to the lid, not to the suite');
  assert.match(text, /120001ms of running time/);
  assert.match(text, /not counted/);
  assert.match(text, /absence of evidence/);
});

test('a ceiling kill says it gave up and why, and refuses to call the check slow', () => {
  const text = verdictText(
    { ran: true, state: 'timeout', name: 'default', sha: 'abc1234', ms: 55000, suspendedMs: 4245000, gaveUp: true, out: '' },
    { cmd: 'node --test' },
  );
  assert.match(text, /slept 4245s mid-check/);
  assert.match(text, /gave up/);
  assert.match(text, /ceiling/);
  assert.match(text, /not the check's speed/);
  assert.match(text, /absence of evidence/);
  assert.doesNotMatch(text, /passed/);
});

test('a pass that rode out a sleep says so, so the timestamps around it still make sense', () => {
  const text = verdictText(
    { ran: true, state: 'pass', name: 'default', sha: 'abc1234', dirty: false, ms: 47053, suspendedMs: 1063000 },
    { cmd: 'node --test' },
  );
  assert.match(text, /in 47053ms/);
  assert.match(text, /slept 1063s mid-check/);
  assert.match(text, /not that the work is correct/);
});

test('a run with no suspension reads exactly as before — no sleep chatter on the ordinary path', () => {
  const pass = verdictText(
    { ran: true, state: 'pass', name: 'unit', sha: 'abc1234', dirty: false, ms: 12 },
    { cmd: 'x' },
  );
  assert.doesNotMatch(pass, /slept|asleep|suspend/);
});

test('runCheck threads the sleep through to what the note will say', async () => {
  const dir = await repo();
  try {
    const r = await runCheck(
      project({ checks: { default: ['whatever'] } }), card(),
      { cwd: dir, run: async () => ({ exit: null, ms: 93254, out: '', timedOut: true, suspendedMs: 964000 }) },
    );
    assert.equal(r.state, 'timeout');
    assert.equal(r.suspendedMs, 964000);
    assert.equal(r.ms, 93254);
    assert.match(verdictText(r, { cmd: cmdOf(r.argv) }), /slept 964s mid-check/,
      'the note is the memory — this sentence is the whole reason suspendedMs travels');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an ordinary spawn result carries no suspension fields at all', async () => {
  const r = await spawnCheck(['node', '-e', 'process.exit(0)'], { cwd: process.cwd(), timeoutMs: 10000 });
  assert.equal(r.exit, 0);
  assert.ok(!('suspendedMs' in r), 'silence on the ordinary path — the field appearing IS the signal');
  assert.ok(!('gaveUp' in r));
});

/* ── what tree it ran against ────────────────────────────── */

test('headState reports the sha and a clean tree', async () => {
  const dir = await repo();
  try {
    const h = await headState(dir);
    assert.match(h.sha, /^[0-9a-f]{7,}$/);
    assert.equal(h.dirty, false);
    assert.equal(h.known, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an uncommitted change makes the tree dirty, so the evidence cannot claim the sha', async () => {
  const dir = await repo();
  try {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    assert.equal((await headState(dir)).dirty, true);
    // Untracked files count too: a check that passes because of a file nobody
    // else has is the same unreproducible claim.
    await writeFile(join(dir, 'a.txt'), 'one\n');
    await writeFile(join(dir, 'b.txt'), 'new\n');
    assert.equal((await headState(dir)).dirty, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outside a repository the sha is unknown rather than absent-and-clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shipward-norepo-'));
  try {
    const h = await headState(dir);
    assert.equal(h.sha, null);
    assert.equal(h.known, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── the whole run ───────────────────────────────────────── */

test('runCheck merges the outcome with the tree it ran against', async () => {
  const dir = await repo();
  try {
    const r = await runCheck(
      project({ checks: { default: ['node', '-e', 'process.exit(0)'] } }), card(), { cwd: dir },
    );
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.dirty, false);
    assert.match(r.sha, /^[0-9a-f]{7,}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCheck with nothing declared runs nothing at all', async () => {
  let called = false;
  const r = await runCheck(project(), card(), { run: () => { called = true; } });
  assert.equal(r.ran, false);
  assert.equal(called, false, 'an undeclared check must not reach the spawn');
  assert.equal(r.state, 'none');
});

test('a promised-but-missing check is its own state, not silence', async () => {
  const r = await runCheck(project({ checks: { unit: ['node', '-v'] } }), card({ check: 'typo' }), {
    run: () => assert.fail('nothing should be spawned'),
  });
  assert.equal(r.state, 'unresolved');
  assert.equal(r.ok, false);
});

test('the record written to the card carries what a later session needs to expire it', () => {
  const v = verificationOf(
    { name: 'unit', argv: ['node', '--test'], exit: 0, ok: true, ms: 8, sha: 'abc1234', dirty: false, state: 'pass' },
    '2026-07-31T10:00:00.000Z',
  );
  // SW-044 reads sha and at; SW-045 counts ok.
  assert.deepEqual(v, {
    check: 'unit', argv: ['node', '--test'], exit: 0, ok: true,
    at: '2026-07-31T10:00:00.000Z', sha: 'abc1234', dirty: false, ms: 8,
  });
});

test('a timed-out record says so and carries no exit code', () => {
  const v = verificationOf({ name: 'u', argv: ['x'], exit: null, ok: false, ms: 300, sha: null, state: 'timeout' }, 'now');
  assert.equal(v.timedOut, true);
  assert.equal(v.exit, null);
});

test('the budget and the default timeout are the values the design ratified', () => {
  assert.equal(OUTPUT_BUDGET, 2000);
  assert.equal(DEFAULT_TIMEOUT_MS, 120000);
  assert.equal(cmdOf(['node', '--test']), 'node --test');
});

/* -- a check never inherits a pointer to the board (SW-050) ---- */

test('checkEnv drops every SHIPWARD_ variable and keeps the rest', () => {
  const out = checkEnv({
    PATH: '/usr/bin', HOME: '/home/x',
    SHIPWARD_TRACKER: '/live/.shipward/tracker.json',
    SHIPWARD_REPO: '/live',
    SHIPWARD_FEED_ARCHIVE: '/live/.shipward/feed-archive.jsonl',
    SHIPWARD_NOTES: '/live/.shipward/notes.jsonl',
  });
  assert.equal(out.PATH, '/usr/bin', 'a check still needs an environment to run in');
  assert.equal(out.HOME, '/home/x');
  assert.equal(out.SHIPWARD_REPO, undefined);
  assert.equal(out.SHIPWARD_FEED_ARCHIVE, undefined);
  assert.equal(out.SHIPWARD_NOTES, undefined);
});

test('checkEnv PINS the tracker rather than merely unsetting it', () => {
  // Unsetting would fall through to the store's cwd rung, and a check runs with
  // cwd set to the repo root — which is where the live board is. The pin is the
  // part that actually closes the door.
  const out = checkEnv({ SHIPWARD_TRACKER: '/live/.shipward/tracker.json' });
  assert.equal(out.SHIPWARD_TRACKER, CHECK_TRACKER);
  assert.notEqual(out.SHIPWARD_TRACKER, '/live/.shipward/tracker.json');
});

test('the pinned path does not exist, so a check reaching for the board fails loudly', async () => {
  await assert.rejects(stat(CHECK_TRACKER), { code: 'ENOENT' },
    'a readable empty board would let a check write into a decoy in silence');
});

test('a real spawned check cannot see the caller\'s tracker', async () => {
  // The end-to-end version, because the whole finding was about what a CHILD
  // inherits and a pure-function test would not have caught the missing `env`.
  const { stdout } = await new Promise((resolve) => {
    spawnCheck(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ t: process.env.SHIPWARD_TRACKER ?? null, r: process.env.SHIPWARD_REPO ?? null }))'],
      { cwd: process.cwd(), timeoutMs: 20000 },
    ).then((r) => resolve({ stdout: r.out }));
  });
  const seen = JSON.parse(stdout);
  assert.equal(seen.t, CHECK_TRACKER, 'the child is pointed at the decoy, not at whatever the server had');
  assert.equal(seen.r, null, 'and is told nothing about which repo the board lives in');
});

test('a check that imports the store cannot reach the live board through it', async () => {
  // The failure this card exists to prevent, exercised rather than argued: the
  // SW-033 shape was a suite resolving the real tracker and writing to it.
  const probe = `import { readRaw } from ${JSON.stringify(join(process.cwd(), 'shipward', 'tracker-store.mjs'))};
    try { await readRaw(); process.stdout.write('READ-A-BOARD'); }
    catch (e) { process.stdout.write(e.name); }`;
  const r = await spawnCheck([process.execPath, '--input-type=module', '-e', probe],
    { cwd: process.cwd(), timeoutMs: 20000 });
  assert.match(r.out, /MissingTrackerError/, 'it finds nothing, and says so');
  assert.doesNotMatch(r.out, /READ-A-BOARD/, 'it must not have found a board at all');
});
