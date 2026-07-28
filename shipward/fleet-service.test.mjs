// The plist is the contract with launchd; test it as data. launchctl itself
// is not exercised here — a test suite must not install services on the
// machine running it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plistFor } from './fleet-service.mjs';

test('the plist pins absolute paths and survives XML-hostile characters', () => {
  const p = plistFor({
    node: '/usr/local/bin/node',
    fleet: '/repos/shipward/fleet.mjs',
    root: '/Users/x/my <projects> & things',
    log: '/Users/x/Library/Logs/shipward-fleet.log',
  });
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(p, /<string>\/repos\/shipward\/fleet\.mjs<\/string>/);
  assert.match(p, /my &lt;projects&gt; &amp; things/, 'a hostile path is escaped, not injected');
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /shipward-fleet\.log/);
  assert.match(p, /com\.shipward\.fleet/);
  // launchd parses this with a real XML parser; a malformed plist fails
  // silently at login, which is the worst possible failure mode.
  assert.equal((p.match(/<dict>/g) || []).length, (p.match(/<\/dict>/g) || []).length);
  assert.equal((p.match(/<array>/g) || []).length, (p.match(/<\/array>/g) || []).length);
});

test('importing the module never runs the CLI', async () => {
  // The import above already proved it: reaching this line means no
  // usage-error exit fired during import.
  assert.ok(plistFor);
});
