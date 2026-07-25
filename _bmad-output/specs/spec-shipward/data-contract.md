# Data contract

`.shipward/schema.json` (JSON Schema 2020-12) is normative and wins over anything restated here. This file consolidates the shape plus the derivation rules the schema cannot express, which the README scatters across "Data schema", "State Management" and "Interactions".

## Shape

```
{version: 1, activeProject, projects[], cards[], feed[]}
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
| `note` | context and decisions; Claude Code appends here |
| `created` / `pushed` / `shipped` | ISO 8601 date-time, or null for the latter two |

**Feed entry** — `{t, p, msg, by}`. `by` is `claude` or `user`. Newest first, capped at 200; entries are never edited, only pushed onto the front and truncated off the tail.

## Id generation

Next id for a project = max numeric suffix among **all** cards carrying that project's prefix — archived ones included — plus one, `padStart(3, "0")`. Ids are never renumbered and never reused, so the counter only moves forward even when cards are deleted.

## Derived views

None of these are stored; all are computed from the card list filtered to `activeProject`.

- **Board columns** — `backlog`, `claude`, `review`, `pushed`. Cards with `status: "shipped"` never appear on the board.
- **Archive rows** — `status: "shipped"`, sorted by `shipped` descending.
- **Stat line** — `in flight` = count of `claude` + `review`; `waiting on you` = count of `review`; `shipped this month` = cards whose `pushed`/`shipped` timestamp falls in the current calendar month (see SPEC open question 3 on precedence).
- **Raw data** — the active project's cards, pretty-printed, fields emitted in this fixed order:

  `id, title, type, priority, effort, status, claude, branch, commit, created, pushed, shipped`

  Note the rename: the card's `pri` is emitted as `priority`, and `p` is dropped (the view is already project-scoped).

## Write rules

- Whole-file read → modify → write. No partial patches.
- Atomic: write to a temp file, then rename over `tracker.json`. Last write wins.
- 2-space pretty-print, ISO 8601 timestamps, `version` stays `1`.
- Every card write appends exactly one feed entry (see `interaction-rules.md` for the copy).
