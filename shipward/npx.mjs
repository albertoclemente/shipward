#!/usr/bin/env node
// The npx entry. `npx shipward <command>` must work from a cold cache — and
// the cache is exactly the place Shipward refuses to live (SW-066): setup and
// fleet-service WRITE this install's path into files the target repo commits,
// and a package cache is a path designed to disappear. So the rule here is
// one rule, not per-command reasoning: when this file finds itself running
// from a transient path, it first installs a durable copy of the whole
// package at ~/.shipward/app and delegates to that. Wiring then records the
// durable path, upgrades are one re-copy when the version differs, and the
// SW-066 refusal inside setup.mjs stays armed as the backstop this file must
// never trip.
//
// From a stable location — a git clone, a global install — it runs in place,
// which is the behaviour every existing document describes.
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');

// The same list setup.mjs refuses on (SW-066). Duplicated deliberately: that
// guard is the last line of defence and must not share a fate with the code
// it guards.
const TRANSIENT = [
  /[/\\]_npx[/\\]/,
  /[/\\]_cacache[/\\]/,
  /[/\\]node_modules[/\\]\.cache[/\\]/,
  /[/\\]\.pnpm-store[/\\]/,
  /[/\\]\.bun[/\\]install[/\\]cache[/\\]/,
];
export const isTransient = (path) => TRANSIENT.some((re) => re.test(`${path}/`));

// Commands that are their own scripts; everything else is a cli.mjs verb
// (standup, recall, log, start, note, done, sync), passed through untouched so
// this file never has to learn a verb the CLI grows later.
const SCRIPTS = {
  setup: 'setup.mjs',
  serve: 'serve.mjs',
  mcp: 'mcp.mjs',
  fleet: 'fleet.mjs',
  'fleet-service': 'fleet-service.mjs',
  status: 'status.mjs',
};
export const planArgs = (argv) => {
  const [cmd, ...rest] = argv;
  if (SCRIPTS[cmd]) return { script: SCRIPTS[cmd], args: rest };
  return { script: 'cli.mjs', args: argv };
};

const versionOf = async (root) => {
  try { return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? null; }
  catch { return null; }
};

// Copy into place via a temp sibling and one rename, because a wired repo's
// hooks may fire mid-copy: they must see the old install or the new one,
// never a half-written directory that "exists" and is missing files.
async function installTo(app, from) {
  const staging = `${app}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(app), { recursive: true });
  await cp(from, staging, {
    recursive: true,
    // The package ships no board, but a copy FROM a clone would drag this
    // repo's own tracker, notes and git dir into every user's install. One
    // exception inside .shipward: schema.json is a product file setup copies
    // into every onboarded repo, not board state.
    // Tested RELATIVE to the source root: the absolute path of an npx cache
    // legitimately contains node_modules, and filtering on it would filter
    // the root itself — copying nothing and calling it success.
    filter: (src) => {
      const rel = relative(from, src);
      if (/^(\.git|node_modules)([/\\]|$)/.test(rel)) return false;
      if (/^\.shipward([/\\]|$)/.test(rel)) {
        return rel === '.shipward' || /^\.shipward[/\\]schema\.json$/.test(rel);
      }
      return true;
    },
  });
  await rm(app, { recursive: true, force: true });
  await rename(staging, app);
}

export async function ensureStable({ home = homedir(), from = PACKAGE } = {}) {
  if (!isTransient(from)) return from;
  const app = join(home, '.shipward', 'app');
  const wanted = await versionOf(from);
  const installed = await versionOf(app);
  // Same version, complete install: nothing to do. A version mismatch in
  // EITHER direction re-copies — `npx shipward@0.1.2` after 0.2.0 should give
  // the version asked for, not silently keep the newer one.
  if (!installed || installed !== wanted) {
    await installTo(app, from);
    console.error(`shipward: installed ${wanted ?? 'unknown version'} to ${app} — wiring written by setup points here, so it survives the npx cache`);
  }
  return app;
}

const USAGE = `usage: shipward <command> [args]

  setup /path/to/repo [--seed-from-branches]   wire a repo to Shipward
  serve                                        the desk at localhost:4747
  fleet [dir]                                  every board on one page (:4740)
  fleet-service install|status|uninstall       make the fleet permanent
  mcp                                          the MCP server on stdio
  status                                       one status line

  standup | recall | log | start | note | done | sync
                                               the board, from any repo that
                                               has one (see cli.mjs --help)`;

const main = async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  const root = await ensureStable({ home: process.env.SHIPWARD_HOME || homedir() });
  const { script, args } = planArgs(argv);
  const child = spawn(process.execPath, [join(root, 'shipward', script), ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.on('error', (err) => { console.error(`shipward: could not run ${script}: ${err.message}`); process.exit(2); });
};

// Import-safe for tests: only run when invoked as a program. Through the
// REAL path on both sides — npm's bin shim is a symlink, so argv[1] arrives
// as .bin/shipward while this module loads under its resolved path, and a
// lexical comparison silently runs nothing and exits 0. Which is the worst
// possible failure for a launcher: it looks exactly like success.
const invokedAsProgram = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedAsProgram) {
  await main();
}
