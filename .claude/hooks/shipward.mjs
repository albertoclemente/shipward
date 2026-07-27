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
async function payload() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const emit = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const quiet = () => process.exit(0);

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

async function sessionStart() {
  const { doc, project, standup } = await tracker();
  context('SessionStart',
    `Shipward — the tracker is your memory for this repo, and this is its current state. `
    + `You did not ask for it because a session that has to remember to look is a session that will not.\n\n`
    + `${standup.standupText(doc, project)}\n\n`
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
  const file = input?.tool_input?.file_path;
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
