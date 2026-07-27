#!/usr/bin/env node
// The ambient surface: one line that says what is in flight, without opening
// anything.
//
// The board answers "show me everything" and you open it a few times a day.
// This answers "what am I in the middle of" and you never open it at all — it
// is simply there, in the status line, on every render. That is the whole idea:
// you do not want to LOOK AT the board, you want to know without looking.
//
// Two constraints shape every decision below, because this runs constantly:
//
//   FAST. No tracker-store.mjs — that module hashes, validates against the
//   whole schema and imports crypto, none of which a read-only glance needs.
//   readFileSync and JSON.parse are the entire data path.
//
//   HARMLESS. A status line that throws, hangs or emits escape codes it did not
//   mean to leaves the user with a broken terminal and no idea why. Every error
//   prints nothing and exits 0.
//
// Usable two ways:
//   node shipward/status.mjs          → print the line (shell prompt, tmux)
//   .claude/settings.json statusLine  → Claude Code renders it every turn
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACKER = process.env.SHIPWARD_TRACKER || join(HERE, '..', '.shipward', 'tracker.json');

// Colour is opt-out rather than opt-in: NO_COLOR is the convention, and a
// status line inherits a terminal we cannot interrogate.
const PLAIN = !!process.env.NO_COLOR || process.env.SHIPWARD_STATUS_PLAIN === '1';
const c = (code, s) => (PLAIN ? s : `[${code}m${s}[0m`);
const accent = (s) => c('38;5;196', s);   // the Shipward red
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// One line, in a space we do not control, so the title is the only thing that
// gives. Everything else is short enough to keep.
const TITLE_BUDGET = 34;
const ID_BUDGET = 16;

// EVERY piece of tracker text is scrubbed before it reaches stdout. A status
// line writes straight into the user's terminal, so a card title is not text —
// it is whatever bytes someone typed, and the terminal will happily obey them.
// Proven against this file: "\u001b]0;PWNED\u0007" in a title rewrote the tab
// title, "\u001b[2J\u001b[H" cleared the screen, "\u001b[?1049h" switched to
// the alternate buffer, a bare "\r" overwrote the line, and a newline turned a
// one-line status line into three. Clipping was no defence — the clear-screen
// payload is seven characters. CLAUDE.md invites hand-editing the tracker and
// log() takes free text, so this is data the product asks for.
//
// C0 controls, DEL, the C1 range, the bidi overrides that visually reorder the
// rest of the line, and the line/paragraph separators all become U+FFFD.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g;
const safe = (v) => String(v ?? '').replace(UNSAFE, '\uFFFD');

// A clip counts UTF-16 code units, so it can land between the halves of an
// emoji; a lone surrogate renders as a replacement glyph.
const dropOrphanSurrogate = (s) => (/[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s);

const clip = (v, n) => {
  const s = safe(v);
  return s.length <= n ? s : `${dropOrphanSurrogate(s.slice(0, n - 1)).trimEnd()}…`;
};

export function statusLine(doc, { openCount = null } = {}) {
  const project = doc.projects?.find((p) => p.id === doc.activeProject) || doc.projects?.[0];
  if (!project) return '';
  const mine = (doc.cards || []).filter((cd) => cd.p === project.id);

  const working = mine.filter((cd) => cd.status === 'claude');
  const review = mine.filter((cd) => cd.status === 'review').length;
  const backlog = mine.filter((cd) => cd.status === 'backlog').length;

  const parts = [];

  if (working.length === 1) {
    const [w] = working;
    // A filled mark for in-flight work, hollow for none: the shape carries the
    // state even in a terminal that has dropped the colour.
    parts.push(`${accent('◆')} ${bold(clip(w.id, ID_BUDGET))} ${dim(clip(w.title, TITLE_BUDGET))}`);
  } else if (working.length > 1) {
    parts.push(`${accent('◆')} ${bold(`${working.length} in flight`)}`);
  } else {
    parts.push(`${dim('◇')} ${dim('no card')}`);
  }

  // Only what is actionable, and only when it is non-zero. A line that always
  // reads "0 review · 0 backlog" is furniture, and furniture stops being read.
  const tail = [];
  if (review) tail.push(`${Number(review)} review`);
  if (backlog) tail.push(`${Number(backlog)} backlog`);
  if (openCount) tail.push(accent(`${Number(openCount)} open`));
  if (tail.length) parts.push(dim('·') + ' ' + tail.join(dim(' · ')));

  return parts.join(' ');
}

// Memory parsing costs an import and a pass over every note. Worth measuring
// before assuming it is free — see the note on SW-016.
// Measured at 390ms for 1000 cards and 1.6s for 5000 — linear, uncapped, and
// in front of everything the line prints. Today's board costs ~10ms, so the
// count stays; past this many cards the line drops it rather than stalling.
const MEMORY_SCAN_LIMIT = 400;

async function openItems(doc) {
  try {
    if ((doc.cards || []).length > MEMORY_SCAN_LIMIT) return null;
    const { memoryEntries, stillOpen } = await import('./public/memory-lib.js');
    const project = doc.projects?.find((p) => p.id === doc.activeProject) || doc.projects?.[0];
    return stillOpen(memoryEntries(doc.cards || [], project.id)).length;
  } catch {
    return null;              // a glance is never worth failing over
  }
}

async function main() {
  const doc = JSON.parse(readFileSync(TRACKER, 'utf8'));
  const line = statusLine(doc, { openCount: await openItems(doc) });
  if (line) process.stdout.write(`${line}\n`);
}

// Only when run directly — importing this for tests must not print anything.
if (process.argv[1] && process.argv[1].endsWith('status.mjs')) {
  main().catch(() => process.exit(0));
}
