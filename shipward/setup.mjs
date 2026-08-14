#!/usr/bin/env node
// Onboard a repository to Shipward, in one command:
//
//   node shipward/setup.mjs /path/to/repo [--name "Catch"] [--prefix CA] [--id catch]
//
// The target repo gets its OWN tracker — .shipward/tracker.json, committed
// with the repo, travelling with it — while the code stays here, central.
// This is the deliberate opposite of pooling every project into one shared
// file: a shared tracker would put every repo's hooks in contention for one
// lock, would write foreign cards into this repo's git history, and would
// break the product's own premise that the tracker is THE REPO'S memory.
//
// What one run wires into the target:
//   .shipward/tracker.json      seeded, one project, empty board
//   .shipward/schema.json       copied from here
//   .claude/settings.json       statusline + the four hooks (merged, never
//                               clobbered), pointing at the central scripts
//                               with SHIPWARD_TRACKER/SHIPWARD_REPO inlined
//   .mcp.json                   the shipward server, same env
//   CLAUDE.md                   the protocol section, appended under a marker
//
// Idempotent by checking, not by overwriting: a second run reports "already
// wired" and changes nothing, and a hand-edited settings.json keeps every key
// it had. Exits non-zero on the first thing it will not do (no repo, no git).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, appendFile } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGit, branchLog } from './git.mjs';
import { seedCards, seedable, previewLines } from './seed.mjs';
import { nextId } from './public/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CENTRAL = resolve(HERE, '..');

const die = (msg) => { console.error(`shipward setup: ${msg}`); process.exit(1); };
const done = [];
const kept = [];

/* ── arguments ───────────────────────────────────────────── */
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
  // A flag whose next token is another flag, or nothing, is a boolean. Without
  // this, --seed-from-branches would swallow the path that follows it.
  const next = args[i + 1];
  if (next === undefined || next.startsWith('--')) flags[args[i].slice(2)] = true;
  else flags[args[i].slice(2)] = args[++i];
}
if (!positional[0]) die('usage: node shipward/setup.mjs /path/to/repo [--name N] [--prefix PX] [--id slug] [--tag line] [--seed-from-branches]');
const seedRequested = flags['seed-from-branches'] === true;

const target = resolve(positional[0]);
if (!existsSync(target)) die(`${target} does not exist`);
if (resolve(target) === CENTRAL) die('this repo is already Shipward — onboarding it onto itself would double the wiring');

// SW-066. Wiring records where Shipward lives, in files the target repo COMMITS.
// That is correct from a clone, whose path is stable and deliberate. It is a
// trap from a package cache: the wiring works on day one, the cache is
// collected later, and every session then starts with four broken hooks inside
// files that may already have been pushed to a team — with nothing pointing
// back here. Refuse rather than write a path that is designed to disappear.
const TRANSIENT = [
  /[/\\]_npx[/\\]/,
  /[/\\]_cacache[/\\]/,
  /[/\\]node_modules[/\\]\.cache[/\\]/,
  /[/\\]\.pnpm-store[/\\]/,
  /[/\\]\.bun[/\\]install[/\\]cache[/\\]/,
];
if (TRANSIENT.some((re) => re.test(`${CENTRAL}/`))) {
  die(`refusing to onboard from ${CENTRAL}\n`
    + '  That is a package cache. Onboarding writes this path into the target repo\'s\n'
    + '  .claude/settings.json, .mcp.json and CLAUDE.md, and those files get committed —\n'
    + '  so the wiring would work today and break silently when the cache is collected.\n'
    + '  Run it through the npx entry, which installs a durable copy at ~/.shipward/app\n'
    + '  first and wires to that:\n'
    + '      npx shipward setup ' + target + '\n'
    + '  or clone Shipward to a stable directory and run setup from there:\n'
    + '      git clone https://github.com/albertoclemente/shipward\n'
    + '      node shipward/setup.mjs ' + target);
}
// The reconciler is half the product, and it reads git. A tracker without a
// repository behind it would hold a board nothing can ever prove wrong.
if (!existsSync(join(target, '.git'))) die(`${target} is not a git repository — run git init first`);

const folder = basename(target);
const id = (flags.id || folder).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
const name = flags.name || folder.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const prefix = (flags.prefix || folder.replace(/[^a-zA-Z]/g, '').slice(0, 2) || 'PR').toUpperCase();
if (!/^[A-Z]+$/.test(prefix)) die(`prefix must be letters only, got "${prefix}"`);
const tag = flags.tag || `the ${name} board`;

/* ── the pieces ──────────────────────────────────────────── */
const HOOK = join(CENTRAL, '.claude', 'hooks', 'shipward.mjs');
const STATUS = join(CENTRAL, 'shipward', 'status.mjs');
const MCP = join(CENTRAL, 'shipward', 'mcp.mjs');
for (const p of [HOOK, STATUS, MCP]) {
  if (!existsSync(p)) die(`central install is missing ${p} — is this script running from a complete checkout?`);
}

// $CLAUDE_PROJECT_DIR resolves at hook run time to the TARGET repo, so the
// central scripts read the target's tracker and audit the target's git.
const env = `SHIPWARD_TRACKER="$CLAUDE_PROJECT_DIR/.shipward/tracker.json" SHIPWARD_REPO="$CLAUDE_PROJECT_DIR"`;
const hookCmd = (which) => `${env} node "${HOOK}" ${which}`;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    die(`${path} exists but is not valid JSON — fix or remove it, nothing was changed`);
  }
}

const writeJson = (path, obj) => writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');

/* ── 1. the tracker ──────────────────────────────────────── */
const shipDir = join(target, '.shipward');
const trackerPath = join(shipDir, 'tracker.json');
const notesPath = join(shipDir, 'notes.jsonl');
await mkdir(shipDir, { recursive: true });

// Read git before writing anything: the preview at the end reports it whether
// or not seeding was asked for, and a repo that cannot be read must say so
// rather than silently look like a repo with no branches.
const gitState = await readGit(target);
const now = new Date().toISOString();

let tracker = await readJson(trackerPath);
if (tracker) {
  kept.push('.shipward/tracker.json (already exists — the board was not touched)');
} else {
  tracker = {
    version: 1,
    activeProject: id,
    projects: [{ id, name, tag, prefix }],
    cards: [],
    feed: [{ t: now, p: id, msg: `${name} onboarded to Shipward — the memory starts now`, by: 'user' }],
  };
  await writeJson(trackerPath, tracker);
  done.push(`.shipward/tracker.json — project "${name}" (${prefix}-…)`);
}

/* ── 1b. a first board, from what git already knows ──────── */
let seeded = null;
if (seedRequested) {
  if (!gitState.ok) {
    die(`--seed-from-branches needs a readable repository: ${gitState.reason}`);
  }
  const project = tracker.activeProject ?? id;
  const cardPrefix = tracker.projects?.find((p) => p.id === project)?.prefix ?? prefix;

  // A branch some card already names is not new work — seeding it again would
  // put two cards on one branch, which is the board contradicting itself on the
  // first screen. Re-running setup must be safe, and this is what makes it so.
  const claimed = new Set((tracker.cards ?? []).map((c) => c.branch).filter(Boolean));
  const candidates = seedable([...gitState.branches.values()]).filter((b) => !claimed.has(b.name));

  const logs = {};
  for (const b of candidates) logs[b.name] = await branchLog(b.name, gitState.trunk, target);

  seeded = seedCards(candidates, {
    project,
    logs,
    now,
    // Ids are allocated against the board as it grows, so seeding into a board
    // that already has cards continues its numbering instead of colliding.
    nextIdFor: (taken) => nextId([...(tracker.cards ?? []), ...taken.map((tid) => ({ id: tid, p: project }))], cardPrefix),
  });

  if (seeded.cards.length) {
    tracker.cards = [...seeded.cards, ...(tracker.cards ?? [])];
    tracker.feed = [
      { t: now, p: project, msg: `${seeded.cards.length} card${seeded.cards.length === 1 ? '' : 's'} seeded from unmerged branches — no sha recorded, the git audit fills those in`, by: 'user' },
      ...(tracker.feed ?? []),
    ].slice(0, 200);
    await writeJson(trackerPath, tracker);
    // One object per line, always ending in a newline: the next writer appends
    // straight onto whatever this leaves behind (SW-068).
    await appendFile(notesPath, seeded.notes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8');
    done.push(`.shipward/tracker.json — ${seeded.cards.length} backlog card${seeded.cards.length === 1 ? '' : 's'} seeded from branches`);
    done.push(`.shipward/notes.jsonl — ${seeded.notes.length} note${seeded.notes.length === 1 ? '' : 's'} recording what git held`);
  } else {
    kept.push('the board (no unmerged branch without a card — nothing to seed)');
  }
}
if (!existsSync(join(shipDir, 'schema.json'))) {
  await copyFile(join(CENTRAL, '.shipward', 'schema.json'), join(shipDir, 'schema.json'));
  done.push('.shipward/schema.json — copied');
} else kept.push('.shipward/schema.json');

/* ── 2. hooks + statusline ───────────────────────────────── */
const claudeDir = join(target, '.claude');
await mkdir(claudeDir, { recursive: true });
const settingsPath = join(claudeDir, 'settings.json');
const settings = (await readJson(settingsPath)) ?? {};

// SW-066. Idempotent by PRESENCE was the bug. A second run saw a shipward hook,
// said "already wired" and changed nothing — so a repo onboarded from an install
// that has since been moved, renamed or reinstalled kept pointing at a path that
// no longer exists, and every session started with four hooks that silently did
// nothing. The hooks exit quietly on any error by design (they must never break
// a session), which is exactly what made this invisible.
//
// Idempotent by CORRECTNESS instead: a wiring that names THIS install is left
// alone, and one that names anywhere else is repaired and reported. Re-running
// setup is now the documented repair, which is the answer a user would guess.
const shipwardHooks = (event) => (settings.hooks?.[event] ?? [])
  .flatMap((g) => g.hooks ?? [])
  .filter((h) => String(h.command ?? '').includes('shipward'));

const EVENTS = [
  ['SessionStart', null, 'session-start'],
  ['UserPromptSubmit', null, 'prompt'],
  ['PreToolUse', 'Edit|Write|NotebookEdit', 'pre-edit'],
  ['Stop', null, 'stop'],
];
let hooksAdded = 0;
let hooksRepaired = 0;
settings.hooks ??= {};
for (const [event, matcher, which] of EVENTS) {
  const existing = shipwardHooks(event);
  if (existing.length) {
    // Compared against the hook SCRIPT path, not the whole command, so a
    // hand-edited env or an extra flag on the line is not mistaken for rot.
    const stale = existing.filter((h) => !String(h.command).includes(HOOK));
    for (const h of stale) h.command = hookCmd(which);
    if (stale.length) { hooksRepaired += stale.length; done.push(`hook ${event} — repointed at this install`); }
    else kept.push(`hook ${event} (already points here)`);
    continue;
  }
  settings.hooks[event] ??= [];
  settings.hooks[event].push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: hookCmd(which) }],
  });
  hooksAdded++;
}

let statusRepaired = false;
const statusCmd = `${env} node "${STATUS}"`;
if (settings.statusLine) {
  const cmd = String(settings.statusLine.command ?? '');
  // Somebody else's status line is still never clobbered — only a Shipward one
  // that has gone stale is repaired.
  if (cmd.includes('status.mjs') && cmd.includes('shipward') && !cmd.includes(STATUS)) {
    settings.statusLine = { type: 'command', command: statusCmd };
    statusRepaired = true;
    done.push('statusLine — repointed at this install');
  } else if (cmd.includes(STATUS)) {
    kept.push('statusLine (already points here)');
  } else {
    kept.push('statusLine (one is already configured — not clobbered; wire Shipward\'s by hand if wanted)');
  }
} else {
  settings.statusLine = { type: 'command', command: statusCmd };
  done.push('statusLine — the one-line Shipward status');
}
if (hooksAdded || hooksRepaired || statusRepaired || !existsSync(settingsPath)) {
  await writeJson(settingsPath, settings);
  if (hooksAdded) done.push(`.claude/settings.json — ${hooksAdded} hook event${hooksAdded === 1 ? '' : 's'} added, existing keys preserved`);
}

/* ── 3. MCP ──────────────────────────────────────────────── */
const mcpPath = join(target, '.mcp.json');
const mcp = (await readJson(mcpPath)) ?? {};
mcp.mcpServers ??= {};
const server = {
  command: 'node',
  args: [MCP],
  env: { SHIPWARD_TRACKER: trackerPath, SHIPWARD_REPO: target },
};
if (mcp.mcpServers.shipward) {
  // A registration pointing at a vanished install fails to start, and the desk
  // simply reads MCP OFFLINE forever — no error anyone would connect to this.
  if (mcp.mcpServers.shipward.args?.[0] !== MCP) {
    mcp.mcpServers.shipward = server;
    await writeJson(mcpPath, mcp);
    done.push('.mcp.json — repointed at this install');
  } else {
    kept.push('.mcp.json (already points here)');
  }
} else {
  mcp.mcpServers.shipward = server;
  await writeJson(mcpPath, mcp);
  done.push('.mcp.json — shipward server, pointed at this repo\'s tracker');
}

/* ── 4. the protocol ─────────────────────────────────────── */
const MARK = '<!-- shipward-protocol -->';
const claudeMd = join(target, 'CLAUDE.md');
const protocol = `${MARK}
# Shipward — your memory and task tracker

**\`.shipward/tracker.json\` is your single source of truth and long-term memory for this repo.** Read it at the start of every session; write to it as you work. If the tracker and your memory disagree, the tracker wins.

An MCP server ("shipward", registered in \`.mcp.json\`) exposes it as seven tools — **prefer them**: \`standup\` (board + memory), \`recall\` (search what is known — call it before editing an unfamiliar file), \`log\` (file a card the moment work is discovered), \`start\` (take a card, get a branch), \`note\` (write to a card's memory without moving it — use it the moment you decide or discover something), \`done\` (hand it back with a note — state the note's \`kind\`, and use \`resolves\` to settle another card's open question), \`sync\` (reconcile with git; \`fromGit:true\` audits, \`apply:true\` accepts the inferences).

The rules, in brief: every piece of work needs a card before it begins (\`log\` then \`start\`); append decisions and gotchas to the card's note as dated entries; \`done\` when finished — the note is what the next session knows, so write what changed, what you decided, and what bit you. Never delete a card; never renumber ids. Statuses: \`backlog → claude → review → pushed\` (landed on main — the git reconciler proves and sets this on its own) \`→ shipped\` (archived). Direct edits to the tracker are a supported fallback when the MCP server is not connected: whole-file read → modify → write, valid against \`.shipward/schema.json\`.

Board state is in \`.shipward/tracker.json\`; **note entries are in \`.shipward/notes.jsonl\`** — append-only, one JSON object per line (\`{"card":"XX-001","t":"…","kind":"…","text":"…"}\`), oldest first, never rewritten. Both are committed and neither is ever deleted. You do not have to manage the split: \`card.note\` is hydrated on every read and stripped on every write, so a card has a \`note\` array wherever you look it up. Editing a note straight into the tracker still works — the next write moves it across — but appending one line to \`notes.jsonl\` is far cheaper than rewriting the board.

Hooks in \`.claude/settings.json\` enforce the loop: a standup is injected at session start (with the board already corrected wherever git can prove it wrong), the active card is named every turn, editing without a card warns, and stopping with a card still \`working\` is refused.

The desk UI: \`node "${join(CENTRAL, 'shipward', 'serve.mjs')}"\` **run from this repo** → http://localhost:4747 shows THIS repo's board (the tools resolve the tracker from the directory you stand in).
${MARK}
`;
const existingMd = existsSync(claudeMd) ? await readFile(claudeMd, 'utf8') : null;
if (existingMd?.includes(MARK)) {
  // Replace only what lies BETWEEN the markers. Everything the user wrote around
  // the block is theirs and is not touched — which is also why the block is
  // marked at both ends rather than merely appended.
  const first = existingMd.indexOf(MARK);
  const last = existingMd.lastIndexOf(MARK);
  const block = existingMd.slice(first, last + MARK.length);
  if (block.includes(CENTRAL) && last > first) {
    kept.push('CLAUDE.md (already points here)');
  } else if (last > first) {
    await writeFile(claudeMd, existingMd.slice(0, first) + protocol.trimEnd() + existingMd.slice(last + MARK.length), 'utf8');
    done.push('CLAUDE.md — protocol section repointed at this install');
  } else {
    // One marker only: a hand-edited or truncated block. Say so rather than
    // guess where it ends and eat somebody's prose.
    kept.push('CLAUDE.md (only one protocol marker found — left alone; remove the block by hand to re-add it)');
  }
} else {
  await writeFile(claudeMd, existingMd ? `${existingMd.trimEnd()}\n\n${protocol}` : protocol, 'utf8');
  done.push(existingMd ? 'CLAUDE.md — protocol section appended' : 'CLAUDE.md — created with the protocol');
}

/* ── report ──────────────────────────────────────────────── */
console.log(`Shipward → ${name} (${target})\n`);
for (const d of done) console.log(`  wired   ${d}`);
for (const k of kept) console.log(`  kept    ${k}`);
if (!done.length) console.log('  nothing to do — this repo is fully wired already');

// The preview runs on EVERY setup, seeded or not. An opt-in flag nobody sees is
// the empty board with extra steps, and the last thing printed is the thing that
// gets read.
console.log('\nWhat git already knows about this repo:\n');
for (const line of previewLines(gitState, {
  seeded,
  command: `node "${join(CENTRAL, 'shipward', 'setup.mjs')}" ${target} --seed-from-branches`,
})) console.log(line);

console.log(`\nNext: open a Claude Code session in ${folder} — the standup arrives by itself.`
  + `\nDesk:  cd ${target} && node "${join(CENTRAL, 'shipward', 'serve.mjs')}"`);
