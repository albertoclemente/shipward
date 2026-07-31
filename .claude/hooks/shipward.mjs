#!/usr/bin/env node
// Shipward hooks — the difference between a protocol that is hoped for and one
// that happens.
//
// CLAUDE.md, the MCP `instructions` field and the tool descriptions are three
// layers of ADVICE, and nothing checks. That is demonstrably not enough: the
// entire MCP server was built for SW-005 without `start` ever being called, so
// the card sat in Backlog while five hundred lines were written against it. If
// the author of the protocol drifts inside one session while holding it in
// context, advice is not a mechanism.
//
//   session-start  inject a standup, so a session begins already knowing
//   prompt         inject one line naming the active card, EVERY turn — this is
//                  the continuous part, because drift cannot accumulate
//   pre-edit       warn when source is about to change with no card in progress
//   stop           refuse to end while a card is still working with no `done`
//
// TWO RULES THIS FILE MUST NEVER BREAK:
//
//   1. A hook cannot be allowed to break a session. Every path exits 0, and any
//      failure — missing tracker, bad JSON, unreadable file — exits silently.
//      A broken hook that bricks the project is worse than no hook at all.
//   2. pre-edit WARNS, it never denies. A hook that gets in the way gets
//      switched off, and a hook that is switched off protects nothing.
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read stdin to the end. Claude Code delivers the hook payload as one JSON
// object; a hook that blocks forever waiting for more would hang the session.
// The isTTY guard covers a terminal, not a pipe someone forgot to close. With
// no timeout the hook waited for a stream that never ended — on
// UserPromptSubmit that is a stall on every single turn, until the runtime
// kills it. The byte cap is the same defence from the other side: 600MiB of
// stdin was buffered in full before this existed.
const STDIN_TIMEOUT_MS = 2000;
const STDIN_MAX_BYTES = 1 << 20;

async function payload() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let bytes = 0;
  // The stream has to be destroyed, not merely signalled: a `for await` blocked
  // on the next chunk never reaches a condition it could check, so an
  // AbortSignal alone left the hook waiting exactly as long as before.
  const cutoff = setTimeout(() => process.stdin.destroy(), STDIN_TIMEOUT_MS);
  cutoff.unref?.();
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > STDIN_MAX_BYTES) break;
    }
  } catch { /* destroyed or closed — use whatever arrived */ }
  clearTimeout(cutoff);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// Nothing this hook prints is worth more than the session it prints into, and
// half a JSON object is worth less than none. process.exit() drops whatever has
// not flushed — a hard cliff at 64KiB on a pipe — so one card with a large
// title made every hook emit truncated, unparseable JSON, and past ~1000 cards
// the Stop hook's output vanished entirely and it silently stopped blocking.
// Failing open was the wrong direction, so the payload is bounded first and the
// write is flushed before exiting.
const MAX_EMIT_BYTES = 48 * 1024;

const done = (code = 0) => {
  // Give the write a chance to drain; exit anyway rather than hang the session.
  if (process.stdout.writableLength === 0) process.exit(code);
  const bail = setTimeout(() => process.exit(code), 2000);
  bail.unref?.();
  process.stdout.once('drain', () => process.exit(code));
};

const emit = (obj) => {
  let body = JSON.stringify(obj);
  if (body.length > MAX_EMIT_BYTES) {
    // Say less, correctly, rather than more, corruptly.
    body = JSON.stringify({
      systemMessage: 'Shipward: the tracker holds more text than a hook can report. Run standup or open the desk.',
    });
  }
  process.stdout.write(body);
  done();
};

const quiet = () => done();

const context = (event, text) => emit({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
});

// Loaded lazily and defensively: the hooks live in the repo, but the repo may
// be mid-edit, and importing a broken module must not take the session with it.
async function tracker() {
  const [{ readRaw }, standup] = await Promise.all([
    import(join(ROOT, 'shipward', 'tracker-store.mjs')),
    import(join(ROOT, 'shipward', 'standup.mjs')),
  ]);
  const { doc } = await readRaw();
  return { doc, project: standup.activeProject(doc), standup };
}

/* ── the four hooks ──────────────────────────────────────── */

// The board says what someone remembered to write down; git says what happened.
// Measured at ~130ms for this repo, which is worth paying once at session start
// and never on a per-turn hook. Budgeted anyway: a slow or enormous repository
// must delay a session by a bounded amount, or not at all.
const AUDIT_BUDGET_MS = 2500;
const DRIFT_SHOWN = 6;
const NO_DRIFT = { text: '', changed: false };

// SW-024 turned this from a report into a correction. What git can PROVE is
// applied here, before the session sees the board, so a session never opens on
// a card git already knows is in the wrong column. Only the `certain` tier is
// written — a monotonic set that fills blanks and confirms landed work — so the
// worst case is a card that moves forward slightly early, never one that loses
// a claim a human made.
//
// It still exits silently on every failure, and it still says NOTHING rather
// than "all clear" when git cannot be read.
async function drift(doc, project) {
  try {
    const [git, rec] = await Promise.all([
      import(join(ROOT, 'shipward', 'git.mjs')),
      import(join(ROOT, 'shipward', 'reconcile.mjs')),
    ]);
    // Default the repo rather than passing ROOT: git.mjs honours SHIPWARD_REPO,
    // and overriding it here would silently defeat that.
    const work = rec.reconcile(doc.cards, project.id);
    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), AUDIT_BUDGET_MS);
      t.unref?.();
    });
    const out = await Promise.race([work, timeout]);
    // Timed out, or git could not be read. Silence, not a guess: "we do not
    // know" must never render as "nothing is wrong".
    if (!out || !out.ok) return NO_DRIFT;

    const fixed = out.applied.length
      ? `\n\nThe board disagreed with git, so the board was corrected — git is the witness for what it can prove.\n`
        + `${rec.describeApplied(out.applied)}\n`
        + 'Already written and recorded in the feed; each card note says why. Nothing else was touched.'
      : '';

    // What is left over: real, but not git's call to settle. Everything held is
    // shown — a rule that silently dropped findings it did not recognise would
    // be indistinguishable from a board with nothing wrong with it.
    const rest = out.held;
    if (!rest.length) return { text: fixed, changed: out.applied.length > 0 };

    const shown = rest.slice(0, DRIFT_SHOWN);
    const lines = shown.map((f) => `  ${f.id || '(no card)'} [${f.rule}] board says ${f.says}; git says ${f.git}`);
    if (rest.length > shown.length) lines.push(`  …and ${rest.length - shown.length} more`);

    return {
      text: `${fixed}\n\nStill unsettled, because git can prove these are wrong but not what is right.`
        + ` ${git.summarise(rest)}\n${lines.join('\n')}\n`
        + 'Nothing has been changed here. sync({fromGit:true}) shows the full picture; add apply:true to accept the inferences.',
      changed: out.applied.length > 0,
    };
  } catch {
    return NO_DRIFT;               // an audit is never worth a session
  }
}

async function sessionStart() {
  const first = await tracker();
  // Reconcile BEFORE rendering, and re-read if anything moved. Describing the
  // board and then correcting it in the same breath would hand the session two
  // answers and no way to tell which one is now.
  const { text, changed } = await drift(first.doc, first.project);
  const { doc, project, standup } = changed ? await tracker() : first;
  // SW-044. Ask git how far the tree has moved since each piece of evidence was
  // written, so the caveat on a standup line is a measurement rather than the
  // same sentence about every entry ever. Budgeted and swallowed like the audit
  // above it: a session start is never worth failing over a git read, and
  // without a drift map every evidence line simply falls back to PERISHABLE.
  //
  // NOT named `drift`: that is already the audit function above, and a `let
  // drift` here put the call to it — three lines earlier, same scope — in the
  // temporal dead zone. The throw was then swallowed by the hook's own
  // catch-all and SessionStart emitted NOTHING: no standup, no audit, no error.
  // Rule 1 (never break a session) and a shadowed binding make silence out of
  // a crash, so the name matters more here than it looks.
  let driftMap;
  try {
    const { driftSince } = await import(join(ROOT, 'shipward', 'git.mjs'));
    const { memoryEntries, anchors } = await import(join(ROOT, 'shipward', 'public', 'memory-lib.js'));
    driftMap = await driftSince(anchors(memoryEntries(doc.cards, project.id)));
  } catch { driftMap = undefined; }
  context('SessionStart',
    `Shipward — the tracker is your memory for this repo, and this is its current state. `
    + `You did not ask for it because a session that has to remember to look is a session that will not.\n\n`
    + `${standup.standupText(doc, project, { drift: driftMap })}`
    + `${text}\n\n`
    + `Before editing a file you have not touched yet, call recall({file:"…"}).`);
}

// Paid for on every single prompt, so it stays one line and does the minimum
// work that makes drift impossible: name the card, or say there isn't one.
async function prompt() {
  const { doc, project, standup } = await tracker();
  context('UserPromptSubmit', standup.activeLine(doc, project));
}

// Files that are not the work: touching them proves nothing about whether a
// card exists, so nagging about them is pure noise.
const EXEMPT = [
  /(^|\/)\.shipward\//,          // the tracker itself — hooks and tools write it
  /(^|\/)\.claude\//,            // hook and command config
  /(^|\/)_bmad-output\//,        // spec and process artifacts
  /(^|\/)\.git\//,
  /(^|\/)(README|CLAUDE)\.md$/i,
];

async function preEdit(input) {
  const file = input?.tool_input?.file_path || input?.tool_input?.notebook_path;
  if (!file) return quiet();

  const rel = relative(ROOT, resolve(file));
  // Outside the repo, or exempt: not our business.
  if (rel.startsWith('..') || rel.startsWith(sep) || EXEMPT.some((re) => re.test(rel))) return quiet();

  const { doc, project, standup } = await tracker();
  const working = standup.workingCards(doc, project);
  if (working.length) return quiet();          // a card is open; nothing to say

  // Allow, always. The warning is the whole intervention.
  emit({
    systemMessage: `⚠ Shipward: about to edit ${rel} with no card in progress.`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Shipward warns but never blocks.',
      additionalContext:
        `Shipward: you are editing ${rel} and no card is in claude/working. Work that is not on a card is `
        + `work the next session cannot see. Call log then start before going further — or, if this is a `
        + `throwaway edit, carry on; this is a warning, not a gate.`,
    },
  });
}

async function stop(input) {
  // The runtime sets this when a Stop hook has already blocked once. Ignoring
  // it would refuse the session forever.
  if (input?.stop_hook_active) return quiet();

  const { doc, project, standup } = await tracker();
  const working = standup.workingCards(doc, project);
  if (!working.length) return quiet();

  const list = working.map((c) => `  ${c.id} (${c.claude || 'queued'}) — ${c.title}`).join('\n');
  emit({
    decision: 'block',
    reason:
      `Shipward still has work open:\n${list}\n\n`
      + `Close it with done({id, commit, note}) — the note is the memory the next session reads, so write what `
      + `changed, what you decided, and anything that bit you. If it genuinely is not finished, say so to the `
      + `user and leave it; do not close it with an empty note to satisfy this hook.`,
  });
}

/* ── dispatch ────────────────────────────────────────────── */
const HOOKS = { 'session-start': sessionStart, prompt, 'pre-edit': preEdit, stop };

try {
  const run = HOOKS[process.argv[2]];
  if (!run) quiet();
  await run(await payload());
} catch {
  // Rule 1. Whatever went wrong, it is not worth a broken session.
  quiet();
}
