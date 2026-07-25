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

- **CAP-5**
  - **intent:** The developer can read and copy the active project's cards as raw JSON to hand to another machine.
  - **success:** The Raw data view pretty-prints the active project's cards in the field order fixed in `data-contract.md`, and "Copy JSON" places that exact text on the clipboard and flips its label for 2s.

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
  - **success:** Selecting a project filters board, archive, raw data and stats to that project's cards, and the choice is written to `activeProject`.

- **CAP-10**
  - **intent:** Claude Code can determine repo state and log its own work from the tracker alone, in a session carrying no prior history.
  - **success:** In a fresh session `/standup` reports in-flight, review and top-backlog items read only from `tracker.json`; `/start`, `/done` and `/log` each mutate the correct card and append a feed entry with `by: "claude"`.

## Constraints

- `.shipward/schema.json` is normative. Every write leaves `tracker.json` valid against it, 2-space pretty-printed, ISO 8601 timestamps.
- **Radius 0 everywhere.** No rounded corners on any element.
- Fidelity is final: colors, typography, spacing and interactions are recreated from the tokens in `design-reference/assets/modernist-scoped.css` (strip the `#sw-1a` scope prefix), not approximated by eye.
- No build step — static vanilla JS or a single-file lightweight framework. No bundler, no transpile.
- Server is zero-dependency Node (built-ins only), ~60 lines, `localhost:4747`, no auth.
- Two endpoints only: `GET /api/tracker`, `PUT /api/tracker`. Writes are whole-file and atomic (tmp + rename); last write wins.
- Claude Code writes `tracker.json` directly, bypassing the server. The UI must tolerate the file changing underneath it at any moment.
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
- No MCP server is built (see open question 1).
- No deletion from the Archive.

## Success signal

Alberto runs `node shipward/serve.mjs`, drags a card from Backlog to Claude working, and in a fresh Claude Code session carrying no conversation history `/standup` names that same card as in flight. Claude finishes it, and the move to Review appears on the board within three seconds without a reload.

## Assumptions

- Live update is GET polling every ~3s rather than `fs.watch` + SSE — the README lists polling first and it keeps the server at ~60 lines.
- The seeded project is `shipward` / prefix `SW`; the shipped seed said "rename me", and Shipward tracks its own construction as SW-001.
- One project at launch; the switcher renders with a single option.
- No optimistic concurrency on PUT — a UI write inside the 3s poll window can overwrite a concurrent Claude Code edit. The README accepts this ("last write wins; the feed makes changes auditable").
- Cards moved to `pushed` through the UI leave `commit` null; only Claude Code sets it.

## Open Questions

- The header's "MCP CONNECTED" tag: the architecture has Claude Code editing `tracker.json` directly, with no MCP server anywhere in the design. Is the tag decorative, or should it reflect a real connection — and if real, what provides it?
- Card deletion contradicts itself across two live sources. The card dialog has a "Delete card" action with feed copy "{id} deleted — one less thing", but `CLAUDE.md` says "Never delete cards — archive them" and the schema says ids are never reused. Is delete human-only, or should the UI drop it too?
- "N shipped this month" is derived from "pushed/shipped timestamp". Which field wins when a card carries both?
- Are projects created and renamed in the UI, or is `projects[]` hand-edited in the file?
