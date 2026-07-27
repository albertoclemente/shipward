---
id: SPEC-shipward
companions:
  - data-contract.md
  - interaction-rules.md
  - ../../../design_handoff_shipward/README.md
  - ../../../CLAUDE.md
sources:
  - ../../../design_handoff_shipward/shipward/tracker.seed.json
  - ../../../design_handoff_shipward/design-reference/seed.js
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Shipward — the solo shipping desk

## Why

A vision to realize. A solo developer shipping side projects with Claude Code has two memories that don't meet: their own, held in a kanban board, and Claude's, held in a conversation that ends. Every session restarts from "what were we doing?", and work Claude discovered mid-task — a bug, a TODO, a promised follow-up — dies with the context window. Shipward makes one file serve both: a kanban board the human drags cards around, and the same JSON file Claude Code reads at session start and writes to as it works. The human gets a board; Claude gets persistent memory; neither has to tell the other what happened.

## Capabilities

- **CAP-1**
  - **intent:** The developer can see every live card for the active project sorted into Backlog / Claude working / Review / Pushed in one view.
  - **success:** With cards present in all four statuses, each renders in exactly one column, the column header counts match the card counts, and a column with no cards shows its specified empty-state line.

- **CAP-2**
  - **intent:** The developer can change a card's status by dragging it between columns, and the change persists.
  - **success:** A drag writes the new status to `tracker.json`, applies the transition rules in `interaction-rules.md`, appends the matching feed entry verbatim, and survives a page reload.

- **CAP-3**
  - **intent:** The developer can create, edit, and delete cards without leaving the board.
  - **success:** "New card" opens the dialog defaulting to feature/P2/M and previews the id the card will take; saving writes a schema-valid card carrying the next unused id for the project prefix; opening an existing card round-trips every field unchanged.

- **CAP-4**
  - **intent:** The developer can review everything the project has pushed to production, newest first.
  - **success:** Cards filed to `shipped` leave the board and appear in the Archive table sorted by `shipped` descending with date, id, title, type, effort and commit; the tab label shows the count.

- **CAP-5** — **WITHDRAWN 2026-07-27.** Was: read and copy the active project's cards as raw JSON. Built (SW-004), then removed (SW-011) — Shipward is for watching Claude Code work, and this view proved the board was a view of a file exactly once, then earned nothing. The id is retained rather than renumbered so CAP-6…CAP-10 keep their meaning in the cards and artifacts that cite them.

- **CAP-6**
  - **intent:** The developer can see what Claude Code last did, and how much work is in flight, without opening the tracker file.
  - **success:** The activity strip shows the newest feed message with a relative timestamp plus the stat line `N in flight · N waiting on you · N shipped this month`, each count derived per `data-contract.md`.

- **CAP-7**
  - **intent:** Claude Code and the UI both work from `tracker.json`, and edits Claude Code makes directly on disk appear in the UI without a manual reload.
  - **success:** With the UI open, an external process editing `tracker.json` causes the board and activity strip to re-render within ~3s.

- **CAP-8**
  - **intent:** Concurrent writes from the UI and Claude Code leave `tracker.json` valid at all times.
  - **success:** Every UI write is a whole-file atomic replace (tmp + rename); a write interrupted mid-flight leaves the previous file intact and schema-valid.

- **CAP-9**
  - **intent:** The developer can switch the active project and have every view follow.
  - **success:** Selecting a project filters board, archive and stats to that project's cards, and the choice is written to `activeProject`.

- **CAP-10**
  - **intent:** Claude Code can determine repo state and log its own work from the tracker alone, in a session carrying no prior history.
  - **success:** In a fresh session `standup` reports in-flight, review and top-backlog items read only from `tracker.json`; `start`, `done` and `log` each mutate the correct card and append a feed entry with `by: "claude"`.

- **CAP-11**
  - **intent:** Claude Code reaches the tracker over MCP rather than by hand-editing JSON, so the rules that govern a card are applied by one implementation instead of restated in a prompt.
  - **success:** An MCP server exposes `standup`, `log`, `start`, `done` and `sync` over stdio; each applies the id, branch, transition and feed rules from the same module the board runs; a direct file edit remains a supported fallback and leaves the tracker equally valid.

- **CAP-12**
  - **intent:** The developer can tell at a glance whether Claude Code is actually connected, rather than reading a badge that is always lit.
  - **success:** The header tag reads `MCP CONNECTED` only while a heartbeat written by a running MCP server is fresher than the staleness window in `data-contract.md`, and reverts to a muted, non-animated `MCP OFFLINE` otherwise.

## Constraints

- `.shipward/schema.json` is normative. Every write leaves `tracker.json` valid against it, 2-space pretty-printed, ISO 8601 timestamps.
- **Radius 0 everywhere.** No rounded corners on any element.
- Fidelity is final: colors, typography, spacing and interactions are recreated from the tokens in `design-reference/assets/modernist-scoped.css` (strip the `#sw-1a` scope prefix), not approximated by eye.
- No build step — static vanilla JS or a single-file lightweight framework. No bundler, no transpile.
- Zero dependencies, Node built-ins only, everywhere — server, store and MCP server alike. The MCP protocol is hand-rolled rather than taking `@modelcontextprotocol/sdk`.
- Desk server is `localhost:4747`, no auth. Two endpoints only: `GET /api/tracker`, `PUT /api/tracker`.
- **Every** read-modify-write of `tracker.json` goes through one store module holding a cross-process advisory lock — the desk, the MCP server and a direct file edit are three writers, and an in-process queue cannot serialize them.
- Writes are whole-file and atomic (tmp + fsync + rename), preserving the file's mode.
- `PUT` carries optimistic concurrency: `GET` returns a content-derived ETag, `PUT` requires `If-Match` (428 without one), and a mismatch answers 409 with the document that won. The lock alone cannot cover this — a desk write's base document came from an unlocked `GET` seconds earlier.
- Claude Code may write `tracker.json` directly, bypassing the server. The UI must tolerate the file changing underneath it at any moment.
- Rules that both the board and Claude apply — id allocation, branch naming, status transitions, feed copy, derived views — live in exactly one module, imported by the browser, the tests and the MCP server. Two copies of a rule drift.
- Card ids are never reused or renumbered. Archiving never removes a card — `shipped` is terminal.
- Feed is newest-first, capped at 200 entries.
- Feed messages use the exact strings in `interaction-rules.md`. They are user-visible copy, not templates to paraphrase.
- Archivo (400/600/800) via Google Fonts; Lucide icons at stroke 2–2.5.

## Non-goals

- No auth, no multi-user, no remote hosting — localhost only.
- No database and no migration layer. The JSON file is the store.
- No npm dependencies, no framework runtime, no package build scripts.
- The prototype's localStorage persistence, simulated Claude pickup, and faked commit shas are not carried into production — `commit` is written by Claude Code alone.
- `design-reference/support.js` is prototype plumbing and is not reused.
- No MCP SDK, and no transport but stdio — no HTTP, no SSE, no remote MCP.
- No raw-JSON view (CAP-5, withdrawn).
- No deletion from the Archive.

## Success signal

Alberto runs `node shipward/serve.mjs`, drags a card from Backlog to Claude working, and in a fresh Claude Code session carrying no conversation history the `standup` tool names that same card as in flight. Claude finishes it through `done`, and the move to Review appears on the board within three seconds without a reload — with the header tag lit, because a server really is on the other end.

## Assumptions

- Live update is GET polling every ~3s rather than `fs.watch` + SSE — the README lists polling first and it keeps the server at ~60 lines.
- The seeded project is `shipward` / prefix `SW`; the shipped seed said "rename me", and Shipward tracks its own construction as SW-001.
- One project at launch; the switcher renders with a single option.
- Cards moved to `pushed` through the UI leave `commit` null; only Claude Code sets it.

**Retired 2026-07-27:** "No optimistic concurrency on PUT — a UI write inside the 3s poll window can overwrite a concurrent Claude Code edit. The README accepts this (*last write wins; the feed makes changes auditable*)." Adversarial review reproduced the loss: the desk overwrote a correctly committed Claude write while the lock worked perfectly, because the desk's base document came from an unlocked `GET`. An audit trail of a destroyed card is not a mitigation. Superseded by the `If-Match` constraint above (SW-008).

## Resolved decisions

All four opening questions were answered by Alberto at build checkpoints. Recorded here so the contract stops asking them.

- **The "MCP CONNECTED" tag** — *"I want the MCP."* A real MCP server, not a decorative tag: see CAP-11 and CAP-12. The badge is now driven by a heartbeat, so a lit tag means a server is genuinely listening.
- **Card deletion** — human-only. The dialog keeps its Delete action; `CLAUDE.md`'s "never delete" binds Claude Code alone. A deleted id stays burned, because id generation scans the max suffix across all cards rather than counting them.
- **`shipped` vs `pushed` precedence** — `shipped ?? pushed`.
- **Project CRUD** — none in the UI. `projects[]` is hand-edited; the switcher only selects.

## Open Questions

- None outstanding.
