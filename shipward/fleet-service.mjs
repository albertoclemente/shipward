#!/usr/bin/env node
// Make the fleet start itself — a macOS LaunchAgent, installed by script.
//
//   node shipward/fleet-service.mjs install [~/projects]
//   node shipward/fleet-service.mjs status
//   node shipward/fleet-service.mjs uninstall
//
// A LaunchAgent because that is what the platform provides for exactly this:
// starts at login, restarts on crash, no terminal involved. Shipped as a
// script rather than hand-written machine config so a new machine — or a
// changed root — is one command, and so the plist itself can be tested as a
// pure function instead of trusted.
//
// Node is pinned by ABSOLUTE path (whatever runs this installer): launchd has
// no shell profile and no PATH worth having, so "node" alone would find
// nothing. The cost is that upgrading Node means re-running install; status
// tells you the pinned path so the surprise is at least inspectable.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = 'com.shipward.fleet';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library', 'Logs', 'shipward-fleet.log');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Pure, so the test can read what would be installed without touching launchd.
export function plistFor({ node, fleet, root, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(fleet)}</string>
    <string>${xml(root)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const sh = (cmd, args) => {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8' }) }; }
  catch (err) { return { ok: false, out: String(err.stderr || err.message) }; }
};

const gui = `gui/${process.getuid()}`;

async function install(rootArg) {
  const root = resolve(rootArg || join(homedir(), 'projects'));
  if (!existsSync(root)) { console.error(`fleet-service: ${root} does not exist`); process.exit(1); }
  const fleet = join(HERE, 'fleet.mjs');

  await mkdir(dirname(PLIST), { recursive: true });
  await writeFile(PLIST, plistFor({ node: process.execPath, fleet, root, log: LOG }), 'utf8');

  // Re-installing must be safe: unload whatever is there, then load fresh.
  // bootout of a service that is not loaded fails, and that is fine.
  sh('launchctl', ['bootout', `${gui}/${LABEL}`]);
  const loaded = sh('launchctl', ['bootstrap', gui, PLIST]);
  if (!loaded.ok) { console.error(`fleet-service: launchctl bootstrap failed — ${loaded.out.trim()}`); process.exit(1); }

  console.log(`Fleet installed and started.\n  watches: ${root}\n  page:    http://localhost:4740`
    + `\n  node:    ${process.execPath} (pinned — re-run install after upgrading Node)`
    + `\n  log:     ${LOG}\n  plist:   ${PLIST}\nIt starts at every login and restarts if it dies.`);
}

async function uninstall() {
  sh('launchctl', ['bootout', `${gui}/${LABEL}`]);
  await unlink(PLIST).catch(() => {});
  console.log('Fleet service removed. The fleet is no longer started automatically.');
}

function status() {
  const res = sh('launchctl', ['print', `${gui}/${LABEL}`]);
  if (!res.ok) { console.log(`not installed (${LABEL} is not loaded)`); return; }
  const pid = res.out.match(/pid = (\d+)/)?.[1];
  console.log(`${LABEL}: loaded${pid ? `, running as pid ${pid}` : ', not currently running'}`);
  console.log(`plist: ${existsSync(PLIST) ? PLIST : 'MISSING — loaded but the file is gone'}`);
}

const cmd = process.argv[2];
if (cmd === 'install') await install(process.argv[3]);
else if (cmd === 'uninstall') await uninstall();
else if (cmd === 'status') status();
else if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('usage: node shipward/fleet-service.mjs install [root] | status | uninstall');
  process.exit(1);
}
