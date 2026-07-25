---
title: 'Shipward desk core — server + board'
type: 'feature'
created: '2026-07-25'
status: 'done'
baseline_commit: '1a07f00'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/specs/spec-shipward/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-shipward/data-contract.md'
  - '{project-root}/_bmad-output/specs/spec-shipward/interaction-rules.md'
  - '{project-root}/design_handoff_shipward/README.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Shipward's tracker file exists and Claude Code already writes to it, but there is no app — no way for a human to see the board, move a card, or capture new work. The design handoff specifies the UI to the pixel and nothing has been built.

**Approach:** A zero-dependency Node server that serves a static no-build UI and brokers atomic reads/writes of `.shipward/tracker.json`, plus the Board view recreated from the hi-fi prototype: four columns, drag & drop, card dialog, Claude activity strip, and a 3s poll so Claude Code's on-disk edits appear live. Archive, Raw data, and the MCP server are separate cards (SW-003/004/005).

## Boundaries & Constraints

**Always:**
- `.shipward/schema.json` is normative — every write leaves the file valid, 2-space pretty-printed, ISO 8601 timestamps, `version: 1`.
- Whole-file atomic writes only: write a temp file, then `rename` over `tracker.json`. Last write wins.
- Radius 0 on every element. Recreate from the tokens in `design_handoff_shipward/design-reference/assets/modernist-scoped.css`, stripping the `#sw-1a` scope prefix.
- Zero runtime dependencies. Node built-ins in the server; vanilla JS in the browser. No bundler, no transpile, no `package.json` build step.
- Feed entries are newest-first, capped at **200** (the prototype's 80 is wrong — the schema says 200), and use the copy in `interaction-rules.md` verbatim.
- Card ids never reused or renumbered; `nextId` scans the max numeric suffix across all cards carrying the project's prefix, archived included.
- The UI must tolerate `tracker.json` changing underneath it at any moment — Claude Code writes it directly, bypassing the server.

**Ask First:**
- Any change to `.shipward/schema.json`, `CLAUDE.md`, or the SPEC contract.
- Adding a runtime dependency, a build step, or a framework.
- Any auth, remote binding, or listening on an interface other than localhost.

**Never:**
- No commit-sha invention. The prototype's `hash()` fakes a sha on review/pushed — production leaves `commit` null for Claude Code to set.
- No simulated Claude pickup. The prototype's `simulate()` timer is prototype-only; real movement comes from file changes.
- No localStorage persistence — the server and `tracker.json` are the store.
- No reuse of `design-reference/support.js` (prototype plumbing).
- No Archive view, Raw data view, or MCP server — deferred to SW-003, SW-004, SW-005.
- No project CRUD; the switcher is read-only and `projects[]` stays hand-edited.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read tracker | `GET /api/tracker` | 200, current `tracker.json` as JSON | Missing file → 404 with a JSON error body; unparseable file → 500, do not serve partial content |
| Write tracker | `PUT /api/tracker` with a valid body | Temp file written then renamed; 200 with the persisted document | Body is not valid JSON, or fails schema shape (`version`, `projects`, `cards`, `feed`) → 400, original file untouched |
| Interrupted write | Process dies mid-write | Previous `tracker.json` intact and schema-valid | Temp file is orphaned, never a partial `tracker.json` |
| External edit | Claude Code rewrites the file while the UI is open | Next poll (≤3s) re-renders board, counts, and activity strip | Poll fails (server down) → keep last known state on screen, do not blank the board |
| Drag to a new column | Card dragged Backlog → Claude working | Status written, `claude: "queued"`, branch auto-named if empty, one feed entry appended | Unknown card id in the drop payload → ignore silently |
| Drag onto its own column | Card dropped where it already is | No-op: no write, no feed entry | N/A |
| Create card | Dialog submitted with a title | New `backlog` card with the next unused id, one feed entry | Empty/whitespace title → refuse to submit, dialog stays open |
| Delete card | "Delete card" in the edit dialog | Card removed, feed entry appended, its id stays burned | N/A — human-only action; Claude Code never deletes |

</frozen-after-approval>

## Code Map

- `shipward/serve.mjs` -- NEW. Zero-dep Node server on 4747: static files from `public/`, `GET`/`PUT /api/tracker` against `../.shipward/tracker.json`, atomic write.
- `shipward/public/index.html` -- NEW. Document shell, Google Fonts link, mount point.
- `shipward/public/app.css` -- NEW. Modernist tokens + component CSS ported from `modernist-scoped.css` with `#sw-1a` stripped, plus the board/strip/tab styles that live inline in the prototype.
- `shipward/public/app.js` -- NEW. State, derive, render, drag & drop, dialog, 3s poll.
- `shipward/public/lib.js` -- NEW. The exported pure-function module the test task called for: tokens of logic with no DOM or fetch (ids, branch naming, transitions, feed, derivations). Imported by both `app.js` in the browser and the test file under Node.
- `shipward/lib.test.mjs` -- NEW. 14 `node --test` assertions over `lib.js`, covering the I/O matrix edge cases.
- `.shipward/tracker.json` -- EXISTING data file. Read/written, never reshaped.
- `.shipward/schema.json` -- EXISTING, normative. Read-only reference.
- `design_handoff_shipward/design-reference/Shipward-Modernist.dc.html` -- Reference markup and logic (lines 17–200 markup, 202–422 behaviour). Port, do not copy — it uses a `{{ }}` template dialect.

## Tasks & Acceptance

**Execution:**
- [x] `shipward/serve.mjs` -- Implement the server: static serving with correct content types, `GET /api/tracker`, `PUT /api/tracker` with tmp+rename and shape validation, bind localhost:4747 -- the single writer the UI goes through.
- [x] `shipward/public/app.css` -- Port the token sheet and components (`.btn`, `.input`, `.seg`, `.card`, `.tag`, `.nav`, `.dialog`) with the scope prefix stripped; add the `swm-blink` keyframes, board grid, column dividers, activity strip, and tab styles the prototype holds inline; add a real `.card:hover` rule replacing the prototype's `style-hover` attribute -- fidelity depends on this being a faithful port.
- [x] `shipward/public/index.html` -- Document shell: charset, viewport, Archivo font link, stylesheet, root element, `app.js` as a module -- no build step means the browser loads sources directly.
- [x] `shipward/public/app.js` -- State container over the fetched tracker; derived columns/stats/activity; render board, cards, and dialog; HTML5 drag & drop with the `interaction-rules.md` transition table; feed append with verbatim copy capped at 200; `nextId`; 3s poll with change detection -- the whole client.
- [x] `shipward/public/app.js` -- Cover the I/O matrix edge cases with assertions runnable via `node --test` or an exported pure-function module: `nextId`, branch auto-naming, transition effects, relative-time thresholds, feed cap -- pure logic must be testable without a browser.

**Acceptance Criteria:**
- Given the server is running and `tracker.json` holds cards in several statuses, when the board loads, then each card appears in exactly one column and every column header count matches its card count.
- Given a column holds no cards, when the board renders, then that column shows its exact empty-state line from the design.
- Given the UI is open, when an external process edits `tracker.json`, then the board and activity strip reflect the change within 3 seconds with no manual reload.
- Given a card is dragged to another column, when the drop completes, then the status change, the transition side-effects, and one verbatim feed entry are persisted and survive a reload.
- Given the dialog is open for a new card, when it is submitted with a title, then a schema-valid card is written carrying the next unused id for the project prefix.
- Given a `PUT` body that is malformed or fails the shape check, when the server handles it, then it responds 400 and `tracker.json` is byte-identical to before.
- Given the server is stopped while the UI is open, when the next poll fails, then the last known board stays on screen rather than blanking.

## Design Notes

The prototype is a `{{ }}` template dialect with `sc-for`/`sc-if`; it is a reference for markup and behaviour, not code to lift. Port the render as plain DOM.

Three places the prototype disagrees with the contract — the contract wins:

- `move()` fakes a commit sha via `hash()` on review/pushed → leave `commit` null.
- `feedAdd` caps at 80 → cap at 200.
- `simulate()` fakes Claude picking a card up after 2.8s → delete entirely; the poll is the real signal.

Transition side-effects, from `interaction-rules.md` (the prototype's `move()` is the working reference):

```js
if (to === 'claude') { u.claude = 'queued'; if (!u.branch) u.branch = autoBranch(c); }
else if (c.claude === 'queued' || c.claude === 'working') u.claude = (to === 'backlog') ? null : 'done';
if (to === 'pushed' && !u.pushed) u.pushed = now;
if (to === 'shipped' && !u.shipped) u.shipped = now;
```

Auto-branch: prefix from type (`bug`→`fix`, `chore`→`chore`, else `feat`), then the title lowercased, stripped to `[a-z0-9 ]`, first 3 words joined by `-`.

## Verification

**Commands:**
- `node --check shipward/serve.mjs && node --check shipward/public/app.js` -- expected: no syntax errors.
- `node --test` -- expected: all pure-logic tests pass (nextId, branch naming, transitions, relative time, feed cap). Note: `node --test shipward/` fails on Node 25 — it tries to resolve the directory as a module. Plain `node --test` discovers `shipward/lib.test.mjs` correctly.
- `node shipward/serve.mjs` then `curl -s localhost:4747/api/tracker | head -c 200` -- expected: the tracker JSON.
- `curl -s -X PUT localhost:4747/api/tracker -d 'not json' -o /dev/null -w '%{http_code}'` -- expected: `400`, and `git diff --stat .shipward/tracker.json` shows no change.

**Manual checks:**
- Board rendered in the browser preview against the prototype opened side by side: column dividers 2px, no rounded corners anywhere, P1 in accent-700, bug type in accent-700, blinking dot on a `working` card.
- Edit `.shipward/tracker.json` in an editor with the page open; the change appears within 3s.

## Suggested Review Order

**The write path — where the reviewers found real corruption**

- Serialized queue + unique temp name; overlapping PUTs used to truncate each other.
  [`serve.mjs:107`](../../shipward/serve.mjs#L107)

- Validation deepened to the schema's required fields; the old check passed `cards:[{}]`.
  [`serve.mjs:41`](../../shipward/serve.mjs#L41)

- Every async handler wrapped; `GET /%` used to exit the process.
  [`serve.mjs:158`](../../shipward/serve.mjs#L158)

- GET now validates too — Claude Code writes this file directly, so damage arrives from outside.
  [`serve.mjs:82`](../../shipward/serve.mjs#L82)

**Two clients, one file — the concurrency seam**

- Poll yields to in-flight writes; a stale GET used to reinstate the pre-write document.
  [`app.js:412`](../../shipward/public/app.js#L412)

- Sequential loop replaces setInterval so a slow GET cannot land after a newer one.
  [`app.js:440`](../../shipward/public/app.js#L440)

- Save merges only fields the human changed, protecting notes Claude appended meanwhile.
  [`app.js:113`](../../shipward/public/app.js#L113)

**Contract conformance**

- UTC getters throughout; local getters made rendering depend on the reader's timezone.
  [`lib.js:19`](../../shipward/public/lib.js#L19)

- Floor not round — rounding emitted "60m ago" and "24h ago", rows the contract lacks.
  [`lib.js:33`](../../shipward/public/lib.js#L33)

- Moving out of production retracts the timestamps that fed "shipped this month".
  [`lib.js:99`](../../shipward/public/lib.js#L99)

- Activity strip reads `by`; it used to label your own drags "Claude Code".
  [`app.js:196`](../../shipward/public/app.js#L196)

**Rendering**

- Board, cards, columns — the port of the prototype's markup into plain DOM.
  [`app.js:222`](../../shipward/public/app.js#L222)

- Token sheet with the `#sw-1a` scope stripped; radius 0 throughout.
  [`app.css:6`](../../shipward/public/app.css#L6)

**Tests**

- Concurrency test reproduces the original corruption: 15 rounds × 6 overlapping writes.
  [`serve.test.mjs:110`](../../shipward/serve.test.mjs#L110)

- Rejected writes leave the file byte-identical across eight malformed bodies.
  [`serve.test.mjs:85`](../../shipward/serve.test.mjs#L85)

- Pure logic, timezone-independent by construction.
  [`lib.test.mjs:91`](../../shipward/lib.test.mjs#L91)
