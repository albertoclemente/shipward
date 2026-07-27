# Shipward — your memory and task tracker

**Shipward (`.shipward/tracker.json`) is your single source of truth and long-term memory for this repo.** You do not rely on conversation history to know what has been done or what is next — the tracker is the record. Read it at the start of every session; write to it as you work. If the tracker and your memory disagree, the tracker wins.

## Reaching it

An MCP server exposes the tracker as five tools. **Prefer them** — they hold a cross-process lock, validate against the schema, allocate ids, name branches and write the feed for you, so the desk UI and you cannot drift apart.

| Tool | Use it to |
|---|---|
| `standup` | read the board: what you are on, what waits for review, top of backlog, what shipped this week |
| `log` | add a backlog card the moment work is discovered or promised |
| `start` | take a card — sets `claude`/`working`, names a branch, hands back the note |
| `done` | hand a card back — `review` (or `pushed`), sets `commit`, appends to the note |
| `sync` | reconcile the board with git in one atomic write |

Registered in `.mcp.json`. Run it standalone with `node shipward/mcp.mjs`; it logs to stderr and speaks JSON-RPC on stdout.

**Fallback — editing `tracker.json` directly is supported and safe** when the MCP server is not connected (the header tag in the desk reads `MCP OFFLINE`, and `tools/list` will not show the five tools). Read → modify → write the whole file, keep it valid against `.shipward/schema.json`, pretty-print with 2 spaces. The desk polls the file, so your edits appear within about 3 seconds either way. The rules below apply whichever route you take.

## The file

All state lives in `.shipward/tracker.json` (schema: `.shipward/schema.json`). Statuses:

- `backlog` — planned, not started
- `claude` — you are actively working on it (set `claude` field: `queued` → `working` → `done`)
- `review` — done, waiting for the human to look at it
- `pushed` — merged/deployed to production
- `shipped` — archived; terminal. Never delete cards — archive them.

Card ids are `PREFIX-NNN` (zero-padded, monotonically increasing per project, never reused).

## Mandatory protocol

1. **Session start:** call `standup`. Report in one line: what's in `claude`/`review`, top of `backlog`.
2. **Before starting any task:** it must exist as a card. If the user asks for something not in the tracker, `log` it first (correct type/pri/effort, note with context), then `start` it — which sets `claude: "working"` and the branch. Check that branch out.
3. **While working:** append decisions and gotchas to the card's `note`. Update `commit` with the latest short sha after each meaningful commit.
4. **Finishing a task:** call `done` (sets `review`, `claude: "done"`, `commit`, appends your note). Only the human moves `review` → `pushed`, unless they tell you to. When something is deployed, pass `pushed: true`.
5. **Discovering work:** any bug found, TODO left, or follow-up promised gets a `log` immediately — nothing lives only in your head or in code comments.
6. **Session end:** every card you touched reflects reality; add one `feed` entry summarizing the session.
7. **Every write** to a card also appends a `feed` entry (`by: "claude"`), newest first, cap 200. The MCP tools do this for you; a direct edit must do it by hand.

## Writing rules

- ISO 8601 timestamps. Never renumber or reuse ids. Never remove `feed` history beyond the 200 cap.
- Branch naming: `feat/…`, `fix/…`, `chore/…` (kebab, ≤3 words) — mirror the card's `type`.
- Commit messages reference the card id: `BW-016: add bloom interval alerts`.
- `note` is append-only in spirit: it is the memory a future session reads, so add to it rather than replacing it.

## The app

`shipward/` contains the tracker UI (see `design_handoff_shipward/README.md` for the spec) and the MCP server. Both read the same `tracker.json`.

- `node shipward/serve.mjs` → the desk at http://localhost:4747
- `node shipward/mcp.mjs` → the MCP server on stdio
- `node --test` → the whole suite

The desk header's `MCP CONNECTED` tag is driven by a heartbeat the MCP server writes to `mcp.lastSeen` every 60s; it goes dark 150s after the last one. A lit tag means a server really is listening.
