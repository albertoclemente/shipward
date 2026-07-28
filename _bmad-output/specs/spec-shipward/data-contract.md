# Data contract

`.shipward/schema.json` (JSON Schema 2020-12) is normative and wins over anything restated here. This file consolidates the shape plus the derivation rules the schema cannot express, which the README scatters across "Data schema", "State Management" and "Interactions".

## Shape

```
{version: 1, activeProject, projects[], cards[], feed[], mcp?}
```

**Project** — `{id, name, tag, prefix}`. `id` is a slug (`shipward`), `prefix` is the card-id prefix (`SW`), `tag` is a one-line descriptor shown under the project name.

**Card** — required: `id, p, title, type, pri, effort, status, created`. Optional: `claude, branch, commit, note, pushed, shipped`.

| field | values |
|---|---|
| `id` | `^[A-Z]+-[0-9]{3}$` — `PREFIX-NNN`, zero-padded, never reused |
| `p` | project id the card belongs to |
| `type` | `feature` \| `bug` \| `chore` |
| `pri` | `P1` \| `P2` \| `P3` |
| `effort` | `S` \| `M` \| `L` |
| `status` | `backlog` \| `claude` \| `review` \| `pushed` \| `shipped` (`shipped` = archived, terminal) |
| `claude` | `queued` \| `working` \| `done` \| `null` — Claude Code's own state while `status: "claude"` |
| `branch` | git branch, e.g. `feat/brew-timer`, or null |
| `commit` | short sha of the latest relevant commit, or null |
| `note` | context and decisions; Claude Code appends here. Since SW-028 (ratified 2026-07-28): an **array of entries** `{t, kind?, text, resolves?}` — `kind` ∈ `open\|finding\|decision\|evidence\|outcome\|brief` (omitted = classified from the text), `resolves` names a card id whose open items this entry settles. Legacy plain-string prose (segments joined by ` \|\| `) remains valid and converts on the next tool append |
| `created` / `pushed` / `shipped` | ISO 8601 date-time, or null for the latter two |

**Feed entry** — `{t, p, msg, by}`. `by` is `claude` or `user`. Newest first, capped at 200; entries are never edited, only pushed onto the front and truncated off the tail. The cap **truncates**; it never rejects. Rejecting a 201st entry froze the tracker permanently once the feed filled, since every card write appends one. Since SW-027, whatever the cap truncates is appended to `.shipward/feed-archive.jsonl` (oldest first, one JSON object per line) by the store before the write — the feed is a window, the archive is the history.

**MCP heartbeat** — `mcp: {lastSeen, pid}`, absent until an MCP server has run. Written every 60s by the running server and by nothing else; it is liveness, not board state, and carries no feed entry. Deliberately in `tracker.json` rather than a sidecar: a committed tracker therefore goes dirty in git about once a minute during a session, which was judged cheaper than two files that can disagree.

## Id generation

Next id for a project = max numeric suffix among **all** cards carrying that project's prefix — archived ones included — plus one, `padStart(3, "0")`. Ids are never renumbered and never reused, so the counter only moves forward even when cards are deleted.

## Derived views

None of these are stored; all are computed from the card list filtered to `activeProject`.

- **Board columns** — `backlog`, `claude`, `review`, `pushed`. Cards with `status: "shipped"` never appear on the board.
- **Archive rows** — `status: "shipped"`, sorted by `shipped` descending. An entry whose `shipped` is missing or unparseable sorts last rather than scrambling the order; Claude Code hand-writes this file, so a bad timestamp is a real input.
- **Stat line** — `in flight` = count of `claude` + `review`; `waiting on you` = count of `review`; `shipped this month` = cards whose `shipped ?? pushed` timestamp falls in the current calendar **month and year**, read with UTC getters so the rendering does not depend on the reader's timezone.
- **MCP status** — `MCP CONNECTED` while `now - mcp.lastSeen` is within **150 s**; `MCP OFFLINE` otherwise, and whenever `mcp` is absent or unparseable. A `lastSeen` in the future reads as live: a disagreeing clock is not a dead server. The window is generous against the 60 s heartbeat so one slow write cannot flicker the tag.
- ~~**Raw data**~~ — withdrawn with CAP-5 on 2026-07-27.

## Write rules

- Whole-file read → modify → write. No partial patches.
- Every read-modify-write runs inside a cross-process advisory lock held for the **whole** cycle, not just the write. Three processes write this file.
- Atomic: write to a temp file, `fsync`, then rename over `tracker.json`, preserving the file's mode.
- **Not** last-write-wins. A writer working from a stale base is refused: `GET` returns a content-derived ETag, `PUT` requires `If-Match` (428 without it), and a mismatch answers 409 carrying the document that won so the caller can re-apply its intent rather than guess.
- 2-space pretty-print, ISO 8601 timestamps, `version` stays `1`.
- Every card write appends exactly one feed entry (see `interaction-rules.md` for the copy). A `sync` audit appends exactly one entry for the whole batch, not one per card.
- A write that would leave the document invalid against the schema is refused, and the file is left byte-identical.
