# Deferred work

- source_spec: none
  summary: Archive view — shipped cards table sorted by shipped desc (SPEC CAP-4).
  evidence: Split from the Shipward build intent at step-01. Independently shippable — own tab, additive, read-only projection over state the desk core already holds; merging it cannot break the board.

- source_spec: none
  summary: Raw data view — pretty-printed active-project cards with Copy JSON (SPEC CAP-5).
  evidence: Split from the Shipward build intent at step-01. Independently shippable — own tab, additive, read-only projection; depends only on the derived-state layer built by the desk core.

- source_spec: none
  summary: MCP server exposing the tracker, so Claude Code reads and writes cards over MCP instead of editing tracker.json directly, and the header's "MCP CONNECTED" tag reflects a real connection.
  evidence: Alberto answered "I want the MCP" at the step-01 checkpoint, overriding the decorative-tag default. This contradicts the SPEC non-goal "No MCP server is built" and answers SPEC open question 1 — SPEC.md needs a bmad-spec re-derive to drop that non-goal. Independent of the desk core: a second client onto the same tracker.json, buildable after it. Also implies revisiting CLAUDE.md, whose protocol currently tells Claude Code to edit the file directly.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: nextId mints a schema-invalid id at card 1000 — padStart(3,'0') yields "SW-1000", which fails schema.json's ^[A-Z]+-[0-9]{3}$.
  evidence: Reproduced by Blind Hunter: nextId([{id:'SW-999'}],'SW') → 'SW-1000'. Fixing it properly means widening the schema pattern, and schema.json is an Ask First item. 994 cards away for this project.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: A card whose status is outside the five-value enum renders in no column and is counted in no header — work disappears silently.
  evidence: Edge Case Hunter. deriveColumns filters by exact key match; a Claude Code typo or a future status value makes the card invisible rather than surfacing it. Needs a design decision on where orphans should appear.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: The new-card dialog's "lands in Backlog as SW-00N" preview goes stale if Claude Code adds a card before submit.
  evidence: Edge Case Hunter. The preview is computed once when the dialog builds; the real id is recomputed at save. Cosmetic mismatch against CAP-3's "previews the id the card will take".

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: Escape or a backdrop click discards typed dialog input with no confirmation.
  evidence: Edge Case Hunter. Real data loss, but the handoff README specifies "Backdrop click closes" — changing it is a design decision, not a bug fix.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: A drop can silently overwrite a status Claude Code wrote during the same 3s poll window, with no indication either happened.
  evidence: Both reviewers. SPEC accepts "last write wins; the feed makes changes auditable" as an assumption, so this is contract-conformant — but the silence is worth revisiting once the MCP server (SW-005) changes how Claude writes.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: There is no Claude-voiced string for card creation, so cards Claude creates read "You added SW-005 to Backlog — it's on the list".
  evidence: Blind Hunter flagged three such entries in the live tracker. interaction-rules.md assigns that copy to card creation universally, with no actor variant. Needs a copy decision from Alberto, then a contract update.

- source_spec: `_bmad-output/implementation-artifacts/spec-shipward-desk-core.md`
  summary: SPEC.md is stale — it still asserts the non-goal "No MCP server is built" and still lists four Open Questions that are all resolved.
  evidence: Blind Hunter. The resolutions live in .memlog.md and in SW-005's note; canonical SPEC.md contradicts shipped behaviour. Fix is a bmad-spec re-derive, which is that skill's job as sole writer of the spec.

- source_spec: `_bmad-output/implementation-artifacts/spec-mcp-tracker-server.md`
  summary: Stage B — the MCP server itself: shipward/mcp.mjs (zero-dep stdio JSON-RPC 2.0, protocol 2025-11-25), the five verb tools (standup, log, start, done, sync), .mcp.json registration, and mcp.test.mjs driving it over a real pipe.
  evidence: Split from SW-005 at the step-02 token check (~2757 tokens against a 1600 ceiling). Depends on stage A: the server is a second writing process, and writing before the cross-process lock exists reintroduces the corruption the desk-core review reproduced.

- source_spec: `_bmad-output/implementation-artifacts/spec-mcp-tracker-server.md`
  summary: Stage C — make MCP the default path: rewrite CLAUDE.md to prefer the tools with direct file edits as fallback, and drive the header's MCP CONNECTED tag from an mcp.lastSeen heartbeat instead of a constant.
  evidence: Split from SW-005 at the step-02 token check. Depends on stage B existing to heartbeat and to be preferred. CLAUDE.md is an Ask First item; Alberto authorised the rewrite at the SW-005 step-01 checkpoint. Carries a known tradeoff: a 60s heartbeat makes the committed tracker.json dirty in git roughly once a minute, versus a .shipward/mcp-status.json sidecar that keeps it clean.
