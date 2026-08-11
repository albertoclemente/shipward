<!-- The technical companion to the README: the same product, explained at the level of
     the code. Moved here when the README was rewritten for people deciding whether to
     use Shipward rather than people reading its source. -->

# Shipward

**A tracker that verifies the agent instead of believing it.**

Shipward is a kanban board for one developer working with a coding agent — and
the same JSON file is the agent's persistent memory. The human drags cards; the
agent reads the board at the start of every session and writes to it as it
works. Neither has to tell the other what happened.

That much is a category with several entries. What makes this one different is
that **it does not take the agent's word for anything it can check.**

```
node shipward/serve.mjs     # the desk, http://localhost:4747
node shipward/mcp.mjs       # the MCP server, for Claude Code
node shipward/cli.mjs       # the same six tools, for anything else
node shipward/fleet.mjs ~/projects   # every board you own, on one page
node --test                 # 446 tests, zero dependencies
```

Zero dependencies, no build step. Vanilla ES modules shared between the
browser, the tests and the server, so the desk and the agent cannot drift apart.

---

## Git outranks the board

The tracker records what someone remembered to write down. Git records what
happened. Where they disagree, git wins **for the things it can prove**, and it
does not wait to be asked:

| Tier | Example | Who writes it |
|---|---|---|
| **certain** | the card's commit is already an ancestor of `main` | applied automatically at session start |
| **proposed** | a branch has commits while the card still says `backlog` | `sync({fromGit: true, apply: true})` |
| **reported** | a `pushed` card whose commit is nowhere on the trunk | a human, always |

The certain tier is **monotonic** — it fills blanks and confirms landed work, and
never moves a card backwards. Move a card ahead of git and the audit will not
overrule you. What it cannot do is invent `backlog`, `review` or a priority:
those are intent, and no commit records intent.

## `done` runs the check

Git outranks the claim about the *commit*. A check outranks the claim about the
*work*. A project declares its checks; a card names one; `done` runs it:

```jsonc
"projects": [{ "id": "shipward", "checks": { "default": ["node", "--test"] } }]
```

| Outcome | Card | Note |
|---|---|---|
| exits 0 | `review` / `pushed` | `evidence`, stamped with the sha it ran against |
| exits non-zero | **stays in progress** | `finding`, with the exit code and output |
| timed out, or names a check nobody declared | **stays in progress** | `finding` — absence of evidence |
| no check declared | promotes | nothing; the reply says it proved nothing |

Checks are **argv arrays declared by a human**, never free text on a card. This
file is written by an agent and by an unauthenticated `PUT`, so a command stored
in it would be an exec for anything that can write the tracker. Nothing blocks:
the note, the commit and the record all land. What a check governs is the
*status granted*. `force: true` promotes anyway and writes a `decision` entry
naming the exit code — an override nobody can find is indistinguishable from a
check that passed.

A pass proves that a declared command exited zero on a named tree. **It does not
prove the work is correct**, and the note says so in those words.

## Evidence expires

Every piece of evidence carries the commit it was true of, so the caveat can be a
measurement instead of the same sentence about every entry ever written:

```
[SW-043 · Jul 31 2026] (4 commits since d859d43, 1 file it names among them)
```

Four readings, keeping the two ways of *not knowing* apart: **current** (still at
that sha), **code moved on**, **unanchored** (no sha, or a dirty tree — datable,
not checkable), and **uncheckable** (a sha git cannot resolve here — never
reported as current). Read it as a narrowing, not a guarantee: nothing here can
tell whether an entry is still true, only whether the code beneath it has moved.

## The memory has a grammar

A card's note is the point of the whole thing. Entries are dated, append-only,
and carry a stated **kind** — `open`, `finding`, `decision`, `evidence`,
`outcome`, `brief` — plus `resolves: "SW-011"` to settle a question another card
left open. `standup` carries the open items and the decisions-not-to-reverse
unasked, each stamped with the card and date it came from, because a session is
being handed something it did not write and cannot verify.

## What nothing can settle

A desk tab that shows the `reported` tier and the questions the board can ask
about itself: claims git contradicts, branches no card owns, changes with no card
in flight, reviews waiting too long, and cards closed after checks existed with
nothing recorded as having run. It reports; it never writes.

## Across every repo

`fleet.mjs` scans a projects root, spawns one ordinary desk per board, and puts
one standup above them all — what is in flight anywhere, what has been waiting
longest, which repos have gone quiet. Trackers are **never pooled**: each repo
keeps its own memory, and the fleet reads across them.

`node shipward/setup.mjs /path/to/repo` wires any git repository in one
idempotent command.

## Not Claude-Code-shaped

The hooks are Claude Code specific; the protocol is not. The same six tools are
an MCP server, a command line, and a JSON file you may edit by hand:

```bash
node shipward/cli.mjs log "the desk overflows below 444px" --type bug --pri P1
node shipward/cli.mjs start SW-042
node shipward/cli.mjs done SW-042 --commit 9a1f2c3 --note "…" --kind outcome
```

Both surfaces call the same handlers and dispatch over the same tool table, so a
command one has and the other lacks is impossible by construction.

**On MCP and tokens:** the usual argument against an MCP surface is schema cost.
Measured 2026-08-01, this server's entire `tools/list` response is **7,363 bytes
— about 1.8k tokens for all six tools**, which is parity with a CLI rather than
the 10–50k that argument assumes. A test pins the ceiling so it stays true as
the tools grow. (It has already grown: it was 6,843 bytes the day before, and
`done` gained two arguments in between. Which is rather the point of the next
section.)

---

## The board in this repo is real

`.shipward/tracker.json` and `.shipward/notes.jsonl` are this project's actual
memory — 56 cards and 168 note entries written while building it, including the
incidents. A lock bug that lost writes. A hook whose catch-all turned a crash
into total silence. A validator written as a snapshot that silently unlinked
every row. They are the best documentation here, and they are what the product
looks like in use.

Those two counts were 55 and 153 an hour before this was written, and the token
figure above was measured a day earlier and was already wrong. Numbers in a
README are evidence, and evidence rots — which is why the product stamps its own
with a commit.

## Requirements

Node 20+. macOS or Linux. No dependencies, no build, no account, no telemetry,
no network calls. It is a file on your disk.

## Licence

MIT — see [LICENSE](LICENSE).
