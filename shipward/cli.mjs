#!/usr/bin/env node
// The protocol, for anything that can run a command.
//
// SW-048. The four hooks are Claude Code specific and the MCP server needs a
// client that speaks it. The PROTOCOL is neither: a card before the work, a
// note after it, git as the witness. This is that surface for any other agent —
// Codex, Cursor, a shell script, a human in a hurry.
//
//   shipward standup
//   shipward recall --file tracker-store.mjs
//   shipward log "the desk overflows below 444px" --type bug --pri P1
//   shipward start SW-042
//   shipward done SW-042 --commit 9a1f2c3 --note "…" --kind outcome
//   shipward sync --from-git
//
// It dispatches over the SAME TOOLS table the MCP server advertises, importing
// the handlers rather than reimplementing them. Two implementations of `done`
// would eventually disagree about what a hand-back means — and this repo's
// whole architecture is arranged against exactly that (public/lib.js is shared
// between the browser, the tests and the server for the same reason).
import { TOOLS, ToolError } from './mcp.mjs';
import { TRACKER } from './tracker-store.mjs';

const TOOL = new Map(TOOLS.map((t) => [t.name, t]));

// Which positional arguments each subcommand takes, so `start SW-042` works and
// nobody has to type `--id`. Everything else is a flag.
//
// An array takes one token each until the last, which takes everything left —
// `note SW-068 the file was unterminated` puts the id in `id` and the rest in
// `text`, without quoting. A bare string is the same rule with one slot.
const POSITIONAL = { log: 'title', start: 'id', done: 'id', recall: 'query', note: ['id', 'text'] };

// Flags whose value is a number, and flags that are true by their presence.
// Derived from the tool's own inputSchema rather than listed here a second
// time: a tool that gains a boolean argument gains a CLI flag for free, and one
// that renames an argument cannot leave a stale flag behind.
const schemaOf = (tool) => tool.inputSchema?.properties || {};
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parse(tool, argv) {
  const props = schemaOf(tool);
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [flag, inline] = a.slice(2).split(/=(.*)/s);
    const key = camel(flag);
    const spec = props[key];
    if (!spec) {
      throw new ToolError(`${tool.name} has no --${flag}. It takes: ${Object.keys(props).map((k) => `--${kebab(k)}`).join(', ') || 'no flags'}`);
    }
    if (spec.type === 'boolean') { args[key] = inline == null ? true : inline !== 'false'; continue; }
    const value = inline != null ? inline : argv[++i];
    if (value == null) throw new ToolError(`--${flag} needs a value`);
    args[key] = spec.type === 'number' ? Number(value) : value;
  }
  // A positional wins only where the flag was not given, so `--id` and a bare
  // id cannot disagree silently.
  const pos = POSITIONAL[tool.name];
  const slots = pos == null ? [] : (Array.isArray(pos) ? pos : [pos]);
  if (!slots.length && rest.length) {
    throw new ToolError(`${tool.name} takes no positional argument (got "${rest.join(' ')}")`);
  }
  let take = rest;
  slots.forEach((slot, i) => {
    if (!take.length) return;
    // The last slot swallows the remainder, so free text needs no quoting.
    const last = i === slots.length - 1;
    const value = last ? take.join(' ') : take[0];
    take = last ? [] : take.slice(1);
    if (args[slot] == null) args[slot] = value;
  });
  return args;
}

export function usage() {
  const lines = [
    'shipward — the tracker, from a shell.',
    '',
    `Board: ${TRACKER}`,
    '',
  ];
  for (const t of TOOLS) {
    const pos = POSITIONAL[t.name];
    const slots = pos == null ? [] : (Array.isArray(pos) ? pos : [pos]);
    const flags = Object.keys(schemaOf(t))
      .filter((k) => !slots.includes(k))
      .map((k) => `--${kebab(k)}`)
      .join(' ');
    const args = slots.map((s) => ` <${s}>`).join('');
    lines.push(`  ${t.name}${args}${flags ? ` [${flags}]` : ''}`);
    // The tool's own one-line description, not a second copy written here.
    lines.push(`      ${t.description.split(/(?<=\.)\s/)[0]}`);
  }
  lines.push('', 'Every command reads and writes the same board the desk and the MCP server use.');
  return lines.join('\n');
}

export async function run(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    return { text: usage(), code: name ? 0 : 1 };
  }
  const tool = TOOL.get(name);
  if (!tool) {
    return { text: `no command "${name}". Have: ${TOOLS.map((t) => t.name).join(', ')}`, code: 1 };
  }
  try {
    return { text: await tool.run(parse(tool, rest)), code: 0 };
  } catch (err) {
    // A ToolError is the caller's mistake and reads as one. Anything else is a
    // bug here, and its stack belongs on stderr rather than swallowed into a
    // tidy message that hides where it came from.
    if (err?.name === 'ToolError') return { text: err.message, code: 1 };
    return { text: err.stack || String(err), code: 2, crash: true };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { text, code, crash } = await run(process.argv.slice(2));
  (crash || code ? process.stderr : process.stdout).write(`${text}\n`);
  process.exitCode = code;
}
