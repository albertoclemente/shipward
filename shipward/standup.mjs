// The standup report, and the formatting rules for recalled memory.
//
// This lives on its own because two very different callers render it: the MCP
// `standup` tool, and the SessionStart hook that injects it before Claude has
// asked for anything. If each built its own, the hook and the tool would drift
// and a session would be told two different stories about the same board.
import { cardsOf, fmtDate } from './public/lib.js';
import { memoryEntries, recall, stillOpen, excerpt } from './public/memory-lib.js';

// How much memory standup carries unasked. Small enough that a session start
// stays cheap, large enough that the things which change what you do next are
// never behind a second call.
export const STANDUP_OPEN = 5;
export const STANDUP_DECISIONS = 6;

// Every recalled entry carries its card id and its date. A session is being
// handed something it did not write and cannot verify; without a provenance
// stamp it can only believe it, and confident wrong memory is worse than none.
export const stamp = (e) => `[${e.card} · ${fmtDate(e.at)}]`;

// Evidence rots. "45 tests pass" was true the morning it was written and is
// false now. Say so at the point of use, not in a doc nobody reads.
export const PERISHABLE = 'as of then, not a claim about now';

export function line(e, { max = 0 } = {}) {
  const caveat = e.kind === 'evidence' ? ` (${PERISHABLE})` : '';
  // Clipped entries lead with the point, not the preamble — see excerpt().
  return `  ${stamp(e)}${caveat} ${max ? excerpt(e, max) : e.text}`;
}

const PRI_ORDER = { P1: 0, P2: 1, P3: 2 };
export const byPriThenAge = (a, b) =>
  (PRI_ORDER[a.pri] ?? 9) - (PRI_ORDER[b.pri] ?? 9) || Date.parse(a.created) - Date.parse(b.created);

export function standupText(doc, project) {
  const mine = cardsOf(doc.cards, project.id);
  const of = (s) => mine.filter((c) => c.status === s);
  const lines = [`${project.name} (${project.prefix}) — ${mine.length} cards`];

  const working = of('claude');
  lines.push(`Claude working (${working.length})`);
  for (const c of working) {
    lines.push(`  ${c.id} ${c.claude || 'queued'}${c.branch ? ` · ${c.branch}` : ''} — ${c.title}`);
  }

  const review = of('review');
  lines.push(`Waiting on you (${review.length})`);
  for (const c of review.slice(0, 5)) lines.push(`  ${c.id} — ${c.title}`);
  if (review.length > 5) lines.push(`  …and ${review.length - 5} more`);

  const backlog = of('backlog').slice().sort(byPriThenAge);
  lines.push(`Backlog (${backlog.length})${backlog.length > 3 ? ' — top 3 by priority, then age' : ''}`);
  for (const c of backlog.slice(0, 3)) lines.push(`  ${c.id} ${c.pri}/${c.effort} — ${c.title}`);

  // "Shipped" here means it reached production, whether or not it has since
  // been filed to the archive.
  const weekAgo = Date.now() - 7 * 86400_000;
  const recent = mine.filter((c) => {
    const t = Date.parse(c.shipped || c.pushed);
    return !Number.isNaN(t) && t >= weekAgo;
  });
  lines.push(`Shipped in the last 7 days (${recent.length})`);
  for (const c of recent) lines.push(`  ${c.id} ${fmtDate(c.shipped || c.pushed)} — ${c.title}`);

  // The memory, which standup used to return none of. Bounded on purpose: the
  // notes are thousands of words and growing, so this carries the two kinds
  // that change what you do next — what is unresolved, and what must not be
  // reversed — clipped, with the card id kept so the full text is one recall
  // away. Everything else waits to be asked for.
  const memory = memoryEntries(doc.cards, project.id);
  if (memory.length) {
    const open = stillOpen(memory);
    if (open.length) {
      lines.push('', `Still open, from the card notes (${open.length})`);
      for (const e of open.slice(0, STANDUP_OPEN)) lines.push(line(e, { max: 240 }));
      if (open.length > STANDUP_OPEN) lines.push(`  …and ${open.length - STANDUP_OPEN} more — recall({kind:"open"})`);
    }
    const decisions = recall(memory, { kind: 'decision', limit: STANDUP_DECISIONS });
    if (decisions.total) {
      lines.push('', `Decisions not to reverse (${decisions.total})`);
      for (const e of decisions.entries) lines.push(line(e, { max: 200 }));
      if (decisions.dropped) lines.push(`  …and ${decisions.dropped} more — recall({kind:"decision"})`);
    }
    const words = memory.reduce((n, e) => n + e.text.split(/\s+/).length, 0);
    lines.push('', `Memory: ${memory.length} entries, ~${words.toLocaleString('en-US')} words. `
      + 'Call recall({file:"…"}) before editing a file — findings are filed by the card that found them, not by the code they concern.');
  }

  return lines.join('\n');
}

// The one line the UserPromptSubmit hook injects every turn. Deliberately tiny:
// it is paid for on every single prompt, and its whole job is to stop drift
// accumulating rather than to inform.
export function activeLine(doc, project) {
  const working = cardsOf(doc.cards, project.id).filter((c) => c.status === 'claude');
  if (!working.length) {
    return 'Shipward: no card in progress. Anything you are about to build needs one — log it, then start it.';
  }
  return `Shipward: ${working.map((c) => `${c.id} (${c.claude || 'queued'}${c.branch ? `, ${c.branch}` : ''}) — ${c.title}`).join('; ')}`;
}

export const workingCards = (doc, project) =>
  cardsOf(doc.cards, project.id).filter((c) => c.status === 'claude');

export const activeProject = (doc) =>
  doc.projects.find((p) => p.id === doc.activeProject) || doc.projects[0] || { id: '', name: '', prefix: '' };
