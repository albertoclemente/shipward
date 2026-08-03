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
| `done` | hand a card back — `review` (or `pushed`), sets `commit`, appends to the note, **and runs the card's check** |
| `sync` | reconcile the board with git — `fromGit:true` reads the repository itself and reports the drift; add `apply:true` to write the fixes it can only infer |

Registered in `.mcp.json`. Run it standalone with `node shipward/mcp.mjs`; it logs to stderr and speaks JSON-RPC on stdout.

The same six are also a **command line**, for any agent that is not Claude Code
and any repo without hook support:

```bash
node shipward/cli.mjs standup
node shipward/cli.mjs recall --file tracker-store.mjs
node shipward/cli.mjs log "the desk overflows below 444px" --type bug --pri P1
node shipward/cli.mjs start SW-042
node shipward/cli.mjs done SW-042 --commit 9a1f2c3 --note "…" --kind outcome
node shipward/cli.mjs sync --from-git
```

It dispatches over the same tool table the MCP server advertises and calls the
same handlers — a subcommand the server does not have, or a tool the CLI cannot
reach, is impossible by construction. Results go to stdout, mistakes to stderr
with exit 1, and a crash to stderr with exit 2.

**Fallback — editing `tracker.json` directly is supported and safe** when the MCP server is not connected (the header tag in the desk reads `MCP OFFLINE`, and `tools/list` will not show the six tools). Read → modify → write the whole file, keep it valid against `.shipward/schema.json`, pretty-print with 2 spaces. The desk polls the file, so your edits appear within about 3 seconds either way. The rules below apply whichever route you take.

To add a **note** this way you have two options, and the cheap one is better: append one JSON object to `.shipward/notes.jsonl` — `{"card":"SW-041","t":"…","kind":"finding","text":"…"}`, one per line, oldest first — which costs you no rewrite of anything. Or write the entry into the card's `note` array in `tracker.json` and let the next write move it across; that is supported, just more bytes.

## The files

Board state lives in `.shipward/tracker.json` (schema: `.shipward/schema.json`). **Note entries live in `.shipward/notes.jsonl`** — append-only, one JSON object per line, oldest first, never rewritten and never compacted. Both are committed; neither is ever deleted.

The split is SW-039, and the reason is size: note text was 68–73% of every board measured, it only ever grows, and it took `git diff` and this fallback down with it. Migrating this repo's own board took `tracker.json` from 182 KB to 48 KB with zero entries lost. **You do not have to think about it** — the store hydrates `card.note` on every read and strips it on every write, so a card still has a `note` array everywhere you look. Migration is automatic: the first write after an upgrade moves whatever is inline.

The two files hold disjoint facts — the tracker never carries note text after a write, the sidecar never carries board state — so there is nothing for them to disagree about.

The tracker also carries a `rev` — a write counter **the store owns** (SW-059). Every locked write bumps it and journals it to `.shipward/last-write.json`, which is untracked and must stay that way: never commit it, never delete its `.gitignore` line. When hand-editing the tracker, carry `rev` forward unchanged. What it catches is git: a `git checkout` or `reset` rewrites the board without ever taking the lock, and a file whose rev is below the journal's proves it happened — reads warn on stderr, the next write records `git rewrote the board` in the feed, and nothing is auto-restored. If you see that warning, the overwritten write is recoverable from git history: `git log -- .shipward/tracker.json`.

Statuses:

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

- ISO 8601 timestamps. Never renumber or reuse ids. Never remove `feed` history beyond the 200 cap (entries the cap trims are preserved automatically in `.shipward/feed-archive.jsonl` — never delete that file either). The same goes double for `.shipward/notes.jsonl`: it is the only copy of the memory, not a spill file.
- Branch naming: `feat/…`, `fix/…`, `chore/…` (kebab, ≤3 words) — mirror the card's `type`.
- Commit messages reference the card id: `BW-016: add bloom interval alerts`.
- `note` is a **list of dated entries** — `{t, kind?, text, resolves?}` — and is append-only: push an entry, never rewrite one. It is the memory a future session reads.
  - **State the `kind`** (`open | finding | decision | evidence | outcome | brief`). A stated kind is a fact; an omitted one is classified from the text, and prose that merely *quotes* a marker word ("the hook failed OPEN") gets misfiled.
  - **`resolves: "SW-011"`** settles the open items of that card — the only way to close a question raised on *another* card. Use it whenever your work answers something an earlier card left open.
  - A plain-string `note` (prose, segments joined by ` || `) is still valid when hand-editing; it converts to entries on the next tool append, stamped with the card's own clock.
  - **An entry is never edited or removed once written.** The sidecar is append-only in fact, not just in spirit: a write whose document has dropped an entry does not delete it, and the next read hands it back.

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

## What `done` proves

Git outranks the claim about the *commit*. A check outranks the claim about the
*work*: `done` runs one before it hands anything back.

A check is **declared by a human on the project**, as an argv array, and a card
carries only its **name**:

```jsonc
"projects": [{ "id": "shipward", "…": "…",
  "checks": { "default": ["node", "--test"] }, "checkTimeoutMs": 120000 }]
"cards":    [{ "id": "SW-043", "…": "…", "check": "default" }]
```

You may **select** a declared check (`done({check: "e2e"})`); you may never
define one. That is not ceremony — this file is written by you and by an
unauthenticated `PUT /api/tracker`, so a command stored in it would be an exec
for anything that can write the tracker. Argv arrays run with no shell, so
nothing inside a check is ever parsed as syntax.

A check also runs with **no `SHIPWARD_*` in its environment**, and with
`SHIPWARD_TRACKER` pinned at a path in the temp dir that does not exist. It used
to inherit the server's environment, so a project whose check is its own test
suite ran that suite holding a pointer to the live board — the shape of the
SW-033 incident, where a sandbox resolved the real tracker and replaced 32 cards.
Unsetting alone would not do: the store falls back to the repo you are standing
in, and a check stands in the repo. So a check that reaches for the board finds
nothing and says so, loudly. If yours genuinely needs the tracker, give it the
path in the argv — never through an env field in this file, which would be the
same injection hole the argv rule exists to close.

What happens then:

| Outcome | Card | Note |
|---|---|---|
| exits 0 | `review` / `pushed` as asked | `evidence`, stamped with the sha it ran against |
| exits non-zero | **stays `claude`/`working`** | `finding`, with the exit code and the output |
| timed out, could not spawn, or names a check nobody declares | **stays `claude`/`working`** | `finding` — absence of evidence, neither pass nor fail |
| no check declared anywhere | `review` / `pushed` as asked | nothing; the reply alone says it proved nothing |

Nothing here blocks the write: the note, the commit and the record all land. What
a check governs is the **status granted**, not whether `done` may speak. To hand
back over a check that did not pass, use `force: true` — which writes a
`decision` entry naming the exit code, because an override nobody can find is
indistinguishable from a check that passed.

A pass proves that a declared command exited zero on a named tree. It does not
prove the work is correct, and the note says so in those words. If the tree was
dirty when the check ran, the evidence says that too — a pass over uncommitted
changes is not reproducible from the sha. `.shipward/` does not count toward
that: the board is not the code under test, and the heartbeat writes to it every
minute, so counting it made every check dirty and the caveat meaningless.

## Evidence expires

Every evidence entry is written with the sha it was true of, so `standup` and
`recall` can say how far the tree has moved since — `4 commits since d859d43,
1 file it names among them` instead of the same blanket caveat on everything.
Four readings, and the two ways of not knowing are kept apart:

- **current** — the sha is still the head of the trunk
- **code moved on** — commits have landed since, and it says whether any touched
  the files the entry itself names
- **unanchored** — no sha, or a dirty tree: datable, not checkable. Entries
  written before this existed are all of these, and they keep the old
  `as of then, not a claim about now` caveat
- **uncheckable** — a sha git cannot resolve here. Never reported as current

Read it as a narrowing, not a guarantee: *current* means nothing has landed
since, which is not the same as still being true. The desk shows the same
verdict on the Memory tab, fading as the work drifts out from under it.

## What nothing can settle

Desk tab **Trust**. The `reported` tier has always been defined and never shown;
this is where it surfaces, alongside the questions the board can ask about
itself. Five rules, and none of them writes anything:

| Finding | Means |
|---|---|
| **Claims git contradicts** | a card says it landed and its commit is not on the trunk |
| **Work no card claims** | a branch with commits that no card names |
| **Changes with no card** | source modified with nothing in `claude` |
| **Waiting on you** | a `review` handed back more than 7 days ago |
| **Closed without a check** | handed back after checks began here, with nothing recorded as having run |

The last one is scoped on purpose: "after checks began" is derived from the
earliest `verification` on the board, so cards closed before this repo could
verify anything are never indicted. Unproven is not an accusation — it reads the
same as verified on a board, and does not read the same at all.

The tab carries a count only when something is unsettled, and an unreadable
repository says so rather than showing an empty all-clear.

## Onboarding another repo

`node shipward/setup.mjs /path/to/repo [--name N] [--prefix PX]` wires any git repository to this install in one idempotent command: seeds the target's **own** `.shipward/tracker.json` (each repo keeps its own memory — trackers are never pooled), merges the four hooks + statusline into its `.claude/settings.json`, registers the MCP server in its `.mcp.json`, and appends the protocol to its `CLAUDE.md`. The central tools resolve by where they run — env `SHIPWARD_TRACKER`/`SHIPWARD_REPO` first, then the repo you are standing in, then this one — so `node <here>/shipward/serve.mjs` from inside an onboarded repo serves *that* repo's board. `node shipward/fleet.mjs ~/projects` (port 4740) shows **every** onboarded board on one page — with one standup across all of them at the top: what is in flight anywhere, what has been waiting on you longest, and which repos have gone quiet (nothing pushed in 21 days, kept distinct from *never* pushed). Boards the walk found but the fleet did not show are **reported**, never dropped silently: it runs at most 16 desks, and a cross-repo answer that omits a repo without saying so reads as full coverage. The rules are pure and live in `public/fleet-digest.js` — and `node shipward/fleet-service.mjs install ~/projects` makes it permanent (a macOS LaunchAgent: starts at login, restarts on crash, logs to ~/Library/Logs/shipward-fleet.log; `status`/`uninstall` to inspect or remove) — it scans two levels deep for trackers and spawns one ordinary desk per board, so clicking a name opens that repo's full desk.

## The app

`shipward/` contains the tracker UI (see `design_handoff_shipward/README.md` for the spec) and the MCP server. Both read the same `tracker.json`.

- `node shipward/serve.mjs` → the desk at http://localhost:4747
- `node shipward/mcp.mjs` → the MCP server on stdio
- `node --test` → the whole suite

The desk header's `MCP CONNECTED` tag is driven by a heartbeat the MCP server writes to `mcp.lastSeen` every 60s; it goes dark 150s after the last one. A lit tag means a server really is listening.
