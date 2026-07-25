---
title: 'Cross-process safe tracker writes — the shared store'
type: 'refactor'
created: '2026-07-25'
status: 'done'
baseline_commit: '88d2338'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/specs/spec-shipward/data-contract.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-shipward-desk-core.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `serve.mjs` serializes writes with an in-process promise chain. That holds only while one process writes. The MCP server (deferred stage B) is a second process, and Claude Code already edits the file by hand — so today a concurrent write reintroduces the corruption the desk-core review reproduced, this time across processes where no existing test would catch it.

**Approach:** Extract reading, validation and the atomic write into one shared store module that takes a cross-process advisory lock spanning the whole read-modify-write. `serve.mjs` becomes a client of it. Stage A of SW-005 — the MCP server and the protocol/heartbeat changes are separate cards.

## Boundaries & Constraints

**Always:**
- The lock spans read *and* write. Two processes must never start a mutation from the same base document.
- Stale-safe: a lock left by a crashed process must not deadlock the desk. Age it out.
- The atomic write stays tmp + rename with a collision-proof temp name.
- Validation is unchanged in behaviour — same rules, same messages, just relocated.
- Zero runtime dependencies; Node built-ins only.

**Ask First:**
- Any change to `.shipward/schema.json` or the validation rules themselves.
- Any change to the HTTP surface (`GET`/`PUT /api/tracker`, status codes, error bodies).

**Never:**
- No MCP server, no `CLAUDE.md` rewrite, no heartbeat, no UI change — stages B and C.
- No behaviour change visible to the browser client. The desk-core suite must pass untouched.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Uncontended write | One process mutates | Lock taken, doc read, written, lock released | Write fails → lock still released |
| Contended write | N processes mutate at once | All serialize; every write lands; file always parses | None lost, none interleaved |
| Stale lock | Lock file older than the threshold | Next writer takes it and proceeds | Log to stderr; never block forever |
| Holder crashes mid-mutation | Lock file remains, no process behind it | Aged out on the next attempt | Tracker left at its last valid state |
| Invalid mutation result | `fn` returns a doc failing validation | Rejected before any write | Lock released, original file intact |
| Mutation returns null | `fn` signals no-op | No write at all | Lock released |
| Missing tracker | File absent | `read()` throws a typed error | `GET` still answers 404 |

</frozen-after-approval>

## Code Map

- `shipward/tracker-store.mjs` -- NEW. `read()`, `mutate(fn)`, `withLock(fn)`, `validate(doc)`, plus the tmp+rename write. The only code that touches the file.
- `shipward/serve.mjs` -- REFACTOR. Imports the store; drops its local validation and `writeQueue`.
- `shipward/store.test.mjs` -- NEW. Cross-process concurrency, stale-lock recovery, validation relocation.
- `shipward/serve.test.mjs` -- UNCHANGED, must still pass. It is the regression gate on the refactor.

## Tasks & Acceptance

**Execution:**
- [x] `shipward/tracker-store.mjs` -- Move `validate` verbatim, add `withLock` (O_EXCL create, retry with backoff, age-out) and `mutate` that reads inside the lock -- the critical section must span the read or two processes diverge from one base.
- [x] `shipward/serve.mjs` -- Rewire `GET`/`PUT` onto the store, delete the in-process queue and local validators -- two guards on one file would drift apart.
- [x] `shipward/store.test.mjs` -- Spawn real child processes writing concurrently; assert the file always parses, every write lands, and no temp or lock files are left behind.

**Acceptance Criteria:**
- Given N processes each append a distinct card concurrently, when they finish, then the tracker parses, validates, and contains all N.
- Given a lock file older than the stale threshold, when a writer starts, then it proceeds rather than blocking.
- Given a mutation whose result fails validation, when it runs, then nothing is written and the lock is released.
- Given the refactor, when `node --test` runs, then the desk-core suite passes unchanged.
- Given a crash between lock acquisition and rename, when the next writer runs, then it succeeds and no `.tmp` remains.

## Design Notes

The lock is an advisory file created with `wx` (O_EXCL) — atomic on POSIX. It records the holder's pid and timestamp so a stale lock is recognisable rather than merely old.

```js
export async function mutate(fn) {
  return withLock(async () => {
    const doc = await read();          // inside the lock — this is the whole point
    const next = await fn(doc);
    if (!next) return doc;             // no-op
    const bad = validate(next);
    if (bad) throw new ValidationError(bad);
    await atomicWrite(next);
    return next;
  });
}
```

`serve.mjs` keeps returning the same status codes and error bodies; the refactor is invisible from the browser. `serve.test.mjs` is the proof.

## Verification

**Commands:**
- `node --check shipward/tracker-store.mjs && node --check shipward/serve.mjs` -- expected: clean.
- `node --test` -- expected: every suite green, desk-core included and unmodified.
- `ls .shipward/*.tmp .shipward/*.lock 2>/dev/null` -- expected: nothing after a test run.
