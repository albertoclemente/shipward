# Handoff: Shipward — solo-dev progress tracker (Claude Code's memory)

## Overview
Shipward is a kanban board + archive for a solo developer shipping side projects with Claude Code. Four working columns (Backlog → Claude working → Review → Pushed) plus a terminal Archive. Its defining trait: **the tracker file is Claude Code's persistent memory.** Claude Code interrogates it to know state, and writes every planned/started/finished piece of work back to it. The human uses the UI; Claude Code uses the same JSON file.

## About the design files
The files in `design-reference/` are **design references created in HTML** — a working prototype showing intended look and behavior, not production code to copy directly. Recreate this design in the target codebase's environment. If no environment exists yet: build it as a **static, no-build web app** (vanilla JS or a single-file lightweight framework) served by a tiny Node server — see Architecture below. Open `design-reference/Shipward-Modernist.dc.html` in a browser to interact with the prototype.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final. Recreate pixel-perfectly using the tokens below (all present in `design-reference/assets/modernist-scoped.css`; strip the `#sw-1a` scoping prefix for production).

## Architecture (what to build)

```
repo/
├── CLAUDE.md                  ← memory protocol (copy of claude/CLAUDE.md here)
├── .claude/commands/          ← slash commands (copies from claude/commands/)
├── .shipward/
│   ├── tracker.json           ← THE data file (seed: shipward/tracker.seed.json)
│   └── schema.json            ← JSON Schema (copy of shipward/schema.json)
└── shipward/                  ← the app
    ├── serve.mjs              ← ~60-line Node server, zero deps:
    │                             serves static UI; GET /api/tracker → tracker.json;
    │                             PUT /api/tracker → atomic write (tmp file + rename)
    └── public/…               ← the UI (recreate the prototype)
```

- **One file, two clients.** The UI and Claude Code both read/write `tracker.json`. Claude Code edits the file directly; the UI goes through the server. The UI polls GET every ~3s (or use fs.watch + SSE) so Claude Code's edits appear live — this replaces the prototype's simulated status line.
- **Writes are whole-file and atomic** (write tmp, rename). Last write wins; the feed makes changes auditable.
- **No auth, localhost only** (`node shipward/serve.mjs` → http://localhost:4747).
- The prototype persists to localStorage; production persists to `tracker.json` via the server. Same shape.

## Data schema
`shipward/schema.json` is normative. Summary: top level `{version, activeProject, projects[], cards[], feed[]}`. Card: `{id "BW-016", p, title, type feature|bug|chore, pri P1|P2|P3, effort S|M|L, status backlog|claude|review|pushed|shipped, claude queued|working|done|null, branch, commit, note, created, pushed, shipped}`. ISO timestamps; ids never reused; `shipped` = archived (never delete). Feed entries `{t, p, msg, by}`, newest first, cap 200.

## Screens / Views

### 1. Board (default)
- **Header bar** (`.nav` pattern): 14px solid accent square + "SHIPWARD" (Archivo 800, letter-spacing 0.03em) + muted "the solo shipping desk" 12px; segmented project switcher (radio `.seg`); "MCP CONNECTED" outline tag with 7px blinking accent dot (2.4s ease-in-out opacity 1→0.2); primary button "New card" (+ icon). Header bottom border 2px divider.
- **Claude activity strip** below header: 40px min-height, 2px bottom divider, 12px text. Terminal icon (accent-700) + bold "Claude Code" + latest feed message (ellipsis) + relative time (muted) + right-aligned stat line "N in flight · N waiting on you · N shipped this month" (Archivo 600).
- **Tabs**: BOARD / ARCHIVE · N / RAW DATA — Archivo 800 13px uppercase letter-spacing 0.08em; active = text color + 3px accent bottom border; inactive = neutral-600.
- **Board grid**: 4 equal columns inside one 2px divider border, min-height 700px; 2px divider between columns (border-left on cols 2–4). No rounded corners anywhere (radius 0).
- **Column header**: count (Archivo 800, 30px) + label (h6 12px) + right-aligned muted hint, 2px bottom divider. Hints: "ideas & queued work" / "delegated over MCP" / "your eyes on it" / "in production".
- **Cards** (`.card`, 1px neutral-300 border, hover neutral-500, cursor grab, 7px gap): row 1 id (11px, 600, ls 0.06em, neutral-600) + right-aligned priority (11px Archivo 800; P1 accent-700, P2 neutral-700, P3 neutral-500); row 2 title (Archivo 600, 14.5px/1.3); row 3 type (bug = accent-700) · effort · right-aligned date (created, or "pushed Mon D"); optional monospace branch row with git-branch icon + short sha; on `status:claude` an uppercase accent-700 line "QUEUED FOR CLAUDE" (dot 40% opacity) or "CLAUDE IS ON IT" (dot blinking 1.1s); on `status:pushed` a ghost "File to archive" button.
- **Backlog column** ends with full-width secondary "+ Add a card" (margin-top auto).
- **Empty columns**: muted 12px copy — "Backlog is clear — dream something up." / "Claude is idle. Drag a card here to delegate." / "Nothing to review — trust your past self." / "The next push lands here."
- **Drag & drop**: HTML5 DnD; column under drag gets accent-100 background; drop moves the card (see State transitions).
- Below grid, muted 11px caption: "Drag a card between columns — Shipward writes the status change straight back to the shared schema Claude Code reads."

### 2. Archive
h3 "Shipped & archived" + muted lede ("Everything {project} has pushed to production — N entries and counting. Look how far it's come."). `.table` sorted by shipped desc: Shipped (Mon D) / ID (mono 12px) / What went out (Archivo 600) / Type / Effort / Commit (mono).

### 3. Raw data
h3 "Raw board data", muted lede about the schema, secondary "Copy JSON" button (label flips to "Copied — feed it to a machine" for 2s), then a `<pre>` (surface bg, 1px divider border, mono 12px/1.55, max-height 560px) with the active project's cards pretty-printed.

### 4. Card dialog (`.dialog-backdrop` + `.dialog`, width min(560px,100%))
Title "New card"/"Edit card" + right meta ("lands in Backlog as BW-022" / "BW-016 · created Jul 14"). Fields: title (required, placeholder "e.g. Brew timer with bloom alerts"); seg groups Type (feature/bug/chore), Priority (P1/P2/P3), Effort (S/M/L) — defaults feature/P2/M; branch (mono, "Branch — optional, Claude names one if you don't"); textarea "Notes for Claude — optional" (placeholder "Context Claude Code sees when it picks this up over MCP"). Actions flush-left: primary "Add to Backlog"/"Save changes", secondary Cancel; ghost "Delete card" pushed right (edit only). Backdrop click closes.

## Interactions & Behavior
- Drag card → column: writes status change + rules below, appends feed entry, persists immediately.
- Move to `claude`: set `claude:"queued"`; auto-name branch if empty (`feat|fix|chore/`kebab-3-words`).
- Move to `review`/`pushed`: keep branch; set `pushed` timestamp on pushed. (Prototype fakes a commit sha; production leaves `commit` to Claude Code.)
- Move to `shipped`: via "File to archive" (or drag out is not needed) — sets `shipped` timestamp; card leaves the board for the Archive tab.
- Move back to `backlog`: clears `claude` state.
- Feed messages, exact copy: add → "You added {id} to Backlog — it's on the list"; claude → "{id} handed to Claude Code — queued"; review → "{id} moved to Review — give it a look"; pushed → "{id} pushed to production — nice work"; shipped → "{id} filed to the archive"; delete → "{id} deleted — one less thing".
- Relative time: "just now" (<90s), "Nm ago" (<1h), "Nh ago" (<24h), else "Mon D".
- Project switcher filters everything (board, archive, raw, stats) to that project.
- In production, replace the prototype's simulated Claude pickup with live file changes: when `tracker.json` changes on disk, re-render and surface the newest feed line in the activity strip.

## State Management
- Whole app state = the tracker file + `{view: board|archive|raw, editing: cardId|'new'|null, dragOver: colKey|null, copied: bool}`.
- Derived: per-column card lists (filtered by project + status), stat line (in flight = claude+review count; waiting = review count; shipped this month by pushed/shipped timestamp), archive rows, raw JSON (cards of active project, cleaned field order: id, title, type, priority, effort, status, claude, branch, commit, created, pushed, shipped).
- id generation: max numeric suffix for the project's prefix + 1, padStart(3,'0').

## Design Tokens (Modernist)
- Ground `--color-bg` #f3f2f2, surface #eae9e9, text #201e1d, accent #ec3013, divider = text at 40% (`color-mix(in srgb, #201e1d 40%, transparent)`).
- Neutral ramp 100–900: #f8f4f4 #eae7e7 #d7d3d3 #bab6b6 #9b9797 #7d7979 #605d5d #444141 #2d2b2b. Accent ramp 100–900: #fff2ef #ffe0d9 #ffc4b8 #ff9783 #ff563c #dd2b0f #ae1800 #7c1405 #4d170e.
- Type: Archivo everywhere (400/600/800), body 15px/1.55; headings weight 800.
- Spacing: 4/8/12/16/24/32. **Radius: 0 everywhere.** Shadows: sm `0 1px 2px` 14%, md `0 3px 10px` 16%, lg `0 12px 32px` 22% of #2d2b2b.
- Rules are strong 2px dividers; structure is visible; labels flush left (including inside buttons). Buttons: primary solid accent, secondary outlined, ghost borderless. Focus: `outline: 2px solid var(--color-accent); outline-offset: 2px`. Icons: Lucide, stroke ~2–2.5.
- Mono details (ids in tables, branch, sha, raw JSON): `ui-monospace, Menlo, monospace`.

## Claude Code memory protocol
`claude/CLAUDE.md` is the drop-in protocol file — copy to the repo root. It makes the tracker mandatory memory: read at session start, card before any work starts, notes/commits recorded while working, statuses updated when finishing, discovered work always logged, feed entry per write. `claude/commands/` holds slash commands to copy into `.claude/commands/`:
- `/standup` — interrogate the tracker, report state (read-only)
- `/log <description>` — add a backlog card
- `/start <id>` — move a card to Claude working + branch
- `/done <id>` — finish to review (or pushed), record commit + notes
- `/sync` — audit tracker against git/deploy reality and fix drift

## Assets
No images. Archivo via Google Fonts (`https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap`). Icons: Lucide (inline SVG in the prototype: plus, terminal, git-branch, archive, copy).

## Files in this bundle
- `design-reference/Shipward-Modernist.dc.html` — the interactive hi-fi prototype (open in a browser)
- `design-reference/assets/modernist-scoped.css` — full token sheet + component CSS (scoped under `#sw-1a`)
- `design-reference/seed.js` — demo dataset showing the schema in use
- `design-reference/support.js` — prototype runtime (ignore; prototype plumbing only)
- `shipward/schema.json`, `shipward/tracker.seed.json` — normative schema + empty starter file
- `claude/CLAUDE.md`, `claude/commands/*.md` — the memory protocol + slash commands
