# Shipward — your memory and task tracker

**Shipward (`.shipward/tracker.json`) is your single source of truth and long-term memory for this repo.** You do not rely on conversation history to know what has been done or what is next — the tracker is the record. Read it at the start of every session; write to it as you work. If the tracker and your memory disagree, the tracker wins.

## Reaching it

An MCP server exposes the tracker as six tools. **Prefer them** — they hold a cross-process lock, validate against the schema, allocate ids, name branches and write the feed for you, so the desk UI and you cannot drift apart.

| Tool | Use it to |
|---|---|
| `standup` | read the board **and the memory**: what you are on, what waits for review, top of backlog, what is still open, and the decisions not to reverse |
| `recall` | search everything previously written down — by file, by kind, or by query |
| `log` | add a backlog card the moment work is discovered or promised |
| `start` | take a card — sets `claude`/`working`, names a branch, hands back the note |
| `done` | hand a card back — `review` (or `pushed`), sets `commit`, appends to the note |
| `sync` | reconcile the board with git — `fromGit:true` reads the repository itself and reports the drift; add `apply:true` to write the fixes it can only infer |

Registered in `.mcp.json`. Run it standalone with `node shipward/mcp.mjs`; it logs to stderr and speaks JSON-RPC on stdout.

**Fallback — editing `tracker.json` directly is supported and safe** when the MCP server is not connected (the header tag in the desk reads `MCP OFFLINE`, and `tools/list` will not show the six tools). Read → modify → write the whole file, keep it valid against `.shipward/schema.json`, pretty-print with 2 spaces. The desk polls the file, so your edits appear within about 3 seconds either way. The rules below apply whichever route you take.

## The file

All state lives in `.shipward/tracker.json` (schema: `.shipward/schema.json`). Statuses:

- `backlog` — planned, not started
- `claude` — you are actively working on it (set `claude` field: `queued` → `working` → `done`)
- `review` — done, waiting for the human to look at it
- `pushed` — landed on the trunk (`main`); this is the status the git reconciler can prove and set on its own
- `shipped` — archived; terminal. Never delete cards — archive them.

Card ids are `PREFIX-NNN` (zero-padded, monotonically increasing per project, never reused).

## Mandatory protocol

0. **Before editing a file you have not touched this session:** call `recall({file: "…"})`. A finding is filed under the card that found it, not under the code it concerns, so the warning you need is never on the card you are working. Recalled entries carry the card and date they came from — judge them, do not simply believe them, and treat anything under **evidence** as a claim about a past state.
1. **Session start:** call `standup`. Report in one line: what's in `claude`/`review`, top of `backlog`.
2. **Before starting any task:** it must exist as a card. If the user asks for something not in the tracker, `log` it first (correct type/pri/effort, note with context), then `start` it — which sets `claude: "working"` and the branch. Check that branch out.
3. **While working:** append decisions and gotchas to the card's `note`. Update `commit` with the latest short sha after each meaningful commit.
4. **Finishing a task:** call `done` (sets `review`, `claude: "done"`, `commit`, appends your note). Only the human moves `review` → `pushed`, unless they tell you to. When something is deployed, pass `pushed: true`.
5. **Discovering work:** any bug found, TODO left, or follow-up promised gets a `log` immediately — nothing lives only in your head or in code comments.
5b. **When the board and git might disagree** — after a merge, or at the start of a session that follows one — call `sync({fromGit: true})`. It reads the repository and reports what does not match. It changes nothing until you ask again with `apply: true`. Note that the drift git can *prove* has usually already been fixed before you get there (see below), so what this reports is mostly what git cannot settle alone.
6. **Session end:** every card you touched reflects reality; add one `feed` entry summarizing the session.
7. **Every write** to a card also appends a `feed` entry (`by: "claude"`), newest first, cap 200. The MCP tools do this for you; a direct edit must do it by hand.

## Writing rules

- ISO 8601 timestamps. Never renumber or reuse ids. Never remove `feed` history beyond the 200 cap (entries the cap trims are preserved automatically in `.shipward/feed-archive.jsonl` — never delete that file either).
- Branch naming: `feat/…`, `fix/…`, `chore/…` (kebab, ≤3 words) — mirror the card's `type`.
- Commit messages reference the card id: `BW-016: add bloom interval alerts`.
- `note` is a **list of dated entries** — `{t, kind?, text, resolves?}` — and is append-only: push an entry, never rewrite one. It is the memory a future session reads.
  - **State the `kind`** (`open | finding | decision | evidence | outcome | brief`). A stated kind is a fact; an omitted one is classified from the text, and prose that merely *quotes* a marker word ("the hook failed OPEN") gets misfiled.
  - **`resolves: "SW-011"`** settles the open items of that card — the only way to close a question raised on *another* card. Use it whenever your work answers something an earlier card left open.
  - A plain-string `note` (prose, segments joined by ` || `) is still valid when hand-editing; it converts to entries on the next tool append.

## Hooks

`.claude/settings.json` wires four hooks to `.claude/hooks/shipward.mjs`, because the rules above are advice and advice decays over a long session:

| Hook | Does |
|---|---|
| `SessionStart` | injects a standup before you ask for one — and first **corrects** the board wherever git can prove it wrong |
| `UserPromptSubmit` | injects one line naming the active card, every turn |
| `PreToolUse` on edits | **warns** — never blocks — when source changes with no card in progress |
| `Stop` | refuses to end the session while a card is still `working` with no `done` |

The same file also wires a **status line** — `node shipward/status.mjs`, one line showing the card in flight and what is waiting. It runs standalone too, for a shell prompt or tmux. ~120ms per render, almost all of it Node startup.

They read the same `tracker.json` everything else does, they exit silently on any error, and they never deny a tool call. They can make you *touch* Shipward; they cannot make you write a note worth reading. `done` with `"fixed it"` satisfies all four and teaches the next session nothing.

## Where git outranks the board

The tracker records what someone remembered to write down. Git records what happened. Where the two disagree, git wins **for the things it can prove** — and it does not wait to be asked:

| Tier | Example | Who writes it |
|---|---|---|
| **certain** | the card's commit is already an ancestor of `main`; the card names a branch but records no sha | applied automatically at session start |
| **proposed** | a branch has commits while the card still says `backlog` — git proves `backlog` is false, but `claude` vs `review` is a guess | `sync({fromGit:true, apply:true})` |
| **reported** | a `pushed` card whose commit is nowhere on the trunk; a branch no card claims | a human, always |

Every automatic correction appends a dated `[git audit …]` line to the card's note saying why, and writes one feed entry. The rules live in `shipward/git.mjs`; the single writer is `shipward/reconcile.mjs`.

**The certain tier is monotonic** — it fills blanks and confirms landed work, and nothing in it moves a card backwards. So if you move a card ahead of what git can see, the audit will never overrule you. What it cannot do is invent `backlog`, `review` or a priority: those are intent, and no commit records intent.

## Onboarding another repo

`node shipward/setup.mjs /path/to/repo [--name N] [--prefix PX]` wires any git repository to this install in one idempotent command: seeds the target's **own** `.shipward/tracker.json` (each repo keeps its own memory — trackers are never pooled), merges the four hooks + statusline into its `.claude/settings.json`, registers the MCP server in its `.mcp.json`, and appends the protocol to its `CLAUDE.md`. The central tools resolve by where they run — env `SHIPWARD_TRACKER`/`SHIPWARD_REPO` first, then the repo you are standing in, then this one — so `node <here>/shipward/serve.mjs` from inside an onboarded repo serves *that* repo's board. `node shipward/fleet.mjs ~/projects` (port 4740) shows **every** onboarded board on one page — it scans two levels deep for trackers and spawns one ordinary desk per board, so clicking a name opens that repo's full desk.

## The app

`shipward/` contains the tracker UI (see `design_handoff_shipward/README.md` for the spec) and the MCP server. Both read the same `tracker.json`.

- `node shipward/serve.mjs` → the desk at http://localhost:4747
- `node shipward/mcp.mjs` → the MCP server on stdio
- `node --test` → the whole suite

The desk header's `MCP CONNECTED` tag is driven by a heartbeat the MCP server writes to `mcp.lastSeen` every 60s; it goes dark 150s after the last one. A lit tag means a server really is listening.
