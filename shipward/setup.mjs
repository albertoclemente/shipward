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
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
if (!positional[0]) die('usage: node shipward/setup.mjs /path/to/repo [--name N] [--prefix PX] [--id slug] [--tag line]');

const target = resolve(positional[0]);
if (!existsSync(target)) die(`${target} does not exist`);
if (resolve(target) === CENTRAL) die('this repo is already Shipward — onboarding it onto itself would double the wiring');
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
await mkdir(shipDir, { recursive: true });
if (existsSync(trackerPath)) {
  kept.push('.shipward/tracker.json (already exists — the board was not touched)');
} else {
  await writeJson(trackerPath, {
    version: 1,
    activeProject: id,
    projects: [{ id, name, tag, prefix }],
    cards: [],
    feed: [{ t: new Date().toISOString(), p: id, msg: `${name} onboarded to Shipward — empty board, the memory starts now`, by: 'user' }],
  });
  done.push(`.shipward/tracker.json — project "${name}" (${prefix}-…), empty board`);
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

const already = (event) => (settings.hooks?.[event] ?? [])
  .some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('shipward')));

const EVENTS = [
  ['SessionStart', null, 'session-start'],
  ['UserPromptSubmit', null, 'prompt'],
  ['PreToolUse', 'Edit|Write|NotebookEdit', 'pre-edit'],
  ['Stop', null, 'stop'],
];
let hooksAdded = 0;
settings.hooks ??= {};
for (const [event, matcher, which] of EVENTS) {
  if (already(event)) { kept.push(`hook ${event} (a shipward hook is already wired)`); continue; }
  settings.hooks[event] ??= [];
  settings.hooks[event].push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: hookCmd(which) }],
  });
  hooksAdded++;
}
if (settings.statusLine) {
  kept.push('statusLine (one is already configured — not clobbered; wire Shipward\'s by hand if wanted)');
} else {
  settings.statusLine = { type: 'command', command: `${env} node "${STATUS}"` };
  done.push('statusLine — the one-line Shipward status');
}
if (hooksAdded || !existsSync(settingsPath)) {
  await writeJson(settingsPath, settings);
  if (hooksAdded) done.push(`.claude/settings.json — ${hooksAdded} hook event${hooksAdded === 1 ? '' : 's'} added, existing keys preserved`);
}

/* ── 3. MCP ──────────────────────────────────────────────── */
const mcpPath = join(target, '.mcp.json');
const mcp = (await readJson(mcpPath)) ?? {};
mcp.mcpServers ??= {};
if (mcp.mcpServers.shipward) {
  kept.push('.mcp.json (a shipward server is already registered)');
} else {
  mcp.mcpServers.shipward = {
    command: 'node',
    args: [MCP],
    env: { SHIPWARD_TRACKER: trackerPath, SHIPWARD_REPO: target },
  };
  await writeJson(mcpPath, mcp);
  done.push('.mcp.json — shipward server, pointed at this repo\'s tracker');
}

/* ── 4. the protocol ─────────────────────────────────────── */
const MARK = '<!-- shipward-protocol -->';
const claudeMd = join(target, 'CLAUDE.md');
const protocol = `${MARK}
# Shipward — your memory and task tracker

**\`.shipward/tracker.json\` is your single source of truth and long-term memory for this repo.** Read it at the start of every session; write to it as you work. If the tracker and your memory disagree, the tracker wins.

An MCP server ("shipward", registered in \`.mcp.json\`) exposes it as six tools — **prefer them**: \`standup\` (board + memory), \`recall\` (search what is known — call it before editing an unfamiliar file), \`log\` (file a card the moment work is discovered), \`start\` (take a card, get a branch), \`done\` (hand it back with a note — state the note's \`kind\`, and use \`resolves\` to settle another card's open question), \`sync\` (reconcile with git; \`fromGit:true\` audits, \`apply:true\` accepts the inferences).

The rules, in brief: every piece of work needs a card before it begins (\`log\` then \`start\`); append decisions and gotchas to the card's note as dated entries; \`done\` when finished — the note is what the next session knows, so write what changed, what you decided, and what bit you. Never delete a card; never renumber ids. Statuses: \`backlog → claude → review → pushed\` (landed on main — the git reconciler proves and sets this on its own) \`→ shipped\` (archived). Direct edits to the tracker are a supported fallback when the MCP server is not connected: whole-file read → modify → write, valid against \`.shipward/schema.json\`.

Hooks in \`.claude/settings.json\` enforce the loop: a standup is injected at session start (with the board already corrected wherever git can prove it wrong), the active card is named every turn, editing without a card warns, and stopping with a card still \`working\` is refused.

The desk UI: \`node "${join(CENTRAL, 'shipward', 'serve.mjs')}"\` **run from this repo** → http://localhost:4747 shows THIS repo's board (the tools resolve the tracker from the directory you stand in).
${MARK}
`;
const existingMd = existsSync(claudeMd) ? await readFile(claudeMd, 'utf8') : null;
if (existingMd?.includes(MARK)) {
  kept.push('CLAUDE.md (the protocol section is already there)');
} else {
  await writeFile(claudeMd, existingMd ? `${existingMd.trimEnd()}\n\n${protocol}` : protocol, 'utf8');
  done.push(existingMd ? 'CLAUDE.md — protocol section appended' : 'CLAUDE.md — created with the protocol');
}

/* ── report ──────────────────────────────────────────────── */
console.log(`Shipward → ${name} (${target})\n`);
for (const d of done) console.log(`  wired   ${d}`);
for (const k of kept) console.log(`  kept    ${k}`);
if (!done.length) console.log('  nothing to do — this repo is fully wired already');
console.log(`\nNext: open a Claude Code session in ${folder} — the standup arrives by itself.`
  + `\nDesk:  cd ${target} && node "${join(CENTRAL, 'shipward', 'serve.mjs')}"`);
