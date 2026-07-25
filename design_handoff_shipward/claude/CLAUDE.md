# Shipward — your memory and task tracker

**Shipward (`.shipward/tracker.json`) is your single source of truth and long-term memory for this repo.** You do not rely on conversation history to know what has been done or what is next — the tracker is the record. Read it at the start of every session; write to it as you work. If the tracker and your memory disagree, the tracker wins.

## The file

All state lives in `.shipward/tracker.json` (schema: `.shipward/schema.json`). Statuses:

- `backlog` — planned, not started
- `claude` — you are actively working on it (set `claude` field: `queued` → `working` → `done`)
- `review` — done, waiting for the human to look at it
- `pushed` — merged/deployed to production
- `shipped` — archived; terminal. Never delete cards — archive them.

Card ids are `PREFIX-NNN` (zero-padded, monotonically increasing per project, never reused).

## Mandatory protocol

1. **Session start:** read the tracker. Report in one line: what's in `claude`/`review`, top of `backlog`.
2. **Before starting any task:** it must exist as a card. If the user asks for something not in the tracker, create the card in `backlog` first (correct type/pri/effort, note with context), then move it to `claude` with `claude: "working"` and set `branch`.
3. **While working:** append decisions and gotchas to the card's `note`. Update `commit` with the latest short sha after each meaningful commit.
4. **Finishing a task:** move to `review` (set `claude: "done"`, `commit`). Only the human moves `review` → `pushed`, unless they tell you to. When something is deployed, set `pushed` timestamp.
5. **Discovering work:** any bug found, TODO left, or follow-up promised gets a `backlog` card immediately — nothing lives only in your head or in code comments.
6. **Session end:** every card you touched reflects reality; add one `feed` entry summarizing the session.
7. **Every write** to a card also appends a `feed` entry (`by: "claude"`), newest first, cap 200.

## Writing rules

- Edit `tracker.json` directly (read → modify → write whole file). Keep it valid against the schema; pretty-print with 2 spaces.
- ISO 8601 timestamps. Never renumber or reuse ids. Never remove `feed` history beyond the 200 cap.
- Branch naming: `feat/…`, `fix/…`, `chore/…` (kebab, ≤3 words) — mirror the card's `type`.
- Commit messages reference the card id: `BW-016: add bloom interval alerts`.

## The app

`shipward/` contains the tracker UI (see `design_handoff_shipward/README.md` for the spec). It reads the same `tracker.json`. If it doesn't exist yet, building it is the first backlog card.
