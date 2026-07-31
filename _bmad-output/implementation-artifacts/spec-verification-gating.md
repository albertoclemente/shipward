# SW-043 — Verification gating

> `done()` runs the card's declared check and records what it proved, at a sha.
> Status: **design, awaiting ratification.** Nothing below is built yet.

## The claim being made

Today `done()` accepts an assertion. The SW-029 nudge asks for a note worth
reading, and nothing anywhere asks whether the work runs. The tracker already
refuses to take the agent's word about *the commit* — `git.mjs` proves whether a
sha is on the trunk, and the `certain` tier writes that correction without being
asked. This card extends the same move one step: **git outranks the claim about
the commit; the check outranks the claim about the work.**

What it does not do, and the copy must never imply otherwise: it does not show
the work is correct. It shows that a *declared* check exited zero at a *named*
sha. An agent that writes a passing test for broken code defeats it completely.
That limit is the reason the evidence carries a sha and a dirty flag rather than
the word "verified" on its own.

## Decisions

### D1 — Checks are declared by a human on the project. Cards select, never invent.

The tracker is agent-writable: `log()` and `done()` write it, and
`PUT /api/tracker` accepts a whole document. If a card carried a free-text
`verify` command, then (a) an agent could author the check it is about to be
graded by, and (b) any process that can write the JSON gets arbitrary code
execution the next time anyone calls `done()`. Both are disqualifying.

So checks live on the **project**, as named argv arrays:

```jsonc
{ "id": "shipward", "name": "Shipward", "prefix": "SW",
  "checks": { "default": ["node", "--test"] },
  "checkTimeoutMs": 120000 }
```

and a card carries at most a **name**:

```jsonc
{ "id": "SW-043", "check": "default" }
```

- `check` names a key; an unknown key is **unverified, never executed**.
- Argv arrays, not shell strings — no shell, so no `&&`, no interpolation, no
  quoting bugs. `spawn(argv[0], argv.slice(1), {shell: false})`.
- MCP tools may set `check` (choosing among what is declared). **No MCP tool may
  write `checks`.** Declaring one is a human edit — the same rule the `reported`
  tier already lives by: some writes are intent, and no process gets to invent
  them.

### D2 — A failing check does not block the write. It declines the promotion.

The house style is that nothing blocks: hooks warn and never deny, the nudge is
advisory, "the write always lands". But the git tiers show the other half — a
claim git disproves is not honored either. Both hold if what the check governs
is not *whether* `done()` writes, but *what status it grants*:

| Outcome | Status | Note written | Reply |
|---|---|---|---|
| exits 0 | `review` (or `pushed`) as today | `evidence`, with sha | "verified at `f5e8993`" |
| exits non-zero | stays `claude`/`working` | `finding`, with exit code + output head | why, and what to run |
| no `check` on the card | `review` as today | `outcome` as today | "**unverified — no check declared**" |
| timed out / spawn failed | stays `claude`/`working` | `finding` | "unverified — timed out after Ns" |
| `force: true` | `review` (or `pushed`) | `decision`, naming the exit code overridden | "promoted over a failing check" |

Three things this buys: no new status (five stay five, the desk grows no
column), no silent override (`force` is *recorded*, not merely permitted), and
silence never reads as success — an unverified card says so in the note, which
is what a future `recall` will surface.

### D3 — The check runs OUTSIDE the tracker lock.

`mutate(fn)` runs `fn` inside `withLock` (`tracker-store.mjs:532`). Waiters give
up at `LOCK_TIMEOUT_MS = 60000`. A 90-second suite inside the mutate callback
would therefore make the desk's next write and any concurrent session's write
**throw**, and this repo has already paid for lock mistakes twice (SW-010,
SW-019). The holder heartbeats every second so it would not be broken as stale —
it would simply starve everything else for the length of the test run.

Sequence, therefore:

1. `read()` the card, resolve the check name — unlocked.
2. Capture `sha` and `dirty` from git — unlocked.
3. Run the check — unlocked, bounded.
4. `mutate()` to write status, `verification` and the note entry — locked, brief.

Between 1 and 4 the card can move under us. The write re-reads the card and
applies the transition to whatever it finds; the evidence records the code state
captured at step 2, because evidence is a claim about the tree, not about the
card.

### D4 — Bounded time, bounded output.

- `checkTimeoutMs`, default **120000**, per project. On expiry: kill the child
  (`SIGTERM`, then `SIGKILL` after a grace), record **unverified — timed out**.
  A timeout is never a pass and never a failure; it is an absence of evidence.
- Capture at most **2000 bytes** of combined stdout/stderr — head and tail, with
  the elision marked. The note *is* the memory: a 3MB test log written into
  `tracker.json` would be re-read by every standup, every recall and the
  SessionStart hook forever. This is the same failure mode SW-041 filed for
  `recall` (caps entries, not bytes); the two cards should use one budget.

### D5 — What gets stamped

On the card, alongside the note entry:

```jsonc
"verification": {
  "check": "default",
  "argv": ["node", "--test"],
  "exit": 0,
  "ok": true,
  "at": "2026-07-31T10:12:03.114Z",
  "sha": "f5e8993",
  "dirty": false,
  "ms": 8412
}
```

`dirty` is load-bearing: a check that passed against uncommitted changes proves
nothing anyone else can reproduce, and the note copy must say so rather than
reporting a clean pass. `sha` is what **SW-044** reads to decide the evidence has
expired, and `ok`/`at` are what the **SW-045** trust panel counts.

Field additions land in **two** places, not one: `.shipward/schema.json` *and*
the hand-rolled `validate()` in `tracker-store.mjs:154`, which deliberately
imports nothing from `public/`. A field added to only one of them passes tests
and poisons a future session.

### D6 — Where it runs

cwd is `REPO` from `git.mjs` (`SHIPWARD_REPO`, else the repo you are standing
in), not the tracker's directory. In a worktree those are different paths — this
very card is being designed from
`.claude/worktrees/SW-043`, whose checked-out `.shipward/tracker.json` is a
*stale copy* of the live board. The runner must resolve the repo explicitly and
the design must not assume they coincide.

### D7 — The runner is injectable

`done()` takes a `run` seam defaulting to the real spawn, so `mcp.test.mjs` can
drive exit 0, exit 1, timeout and spawn-failure without launching a process —
the same shape the store's seams are already tested through. Fixture checks in
the tests are argv arrays like `["node","-e","process.exit(1)"]` for the few
cases that should really spawn.

## Scope

**Build now (the M inside this L):** project `checks` + card `check`; the bounded
runner; the five outcomes incl. `force`; `verification` on the card; schema and
`validate()`; the note copy; tests through the injected seam.

**Deferred, and to which card:** the desk badge and its fading (SW-044/SW-045),
the standalone `shipward verify <id>` entry point (SW-048), and any notion of
*required* checks per project — a project-wide "no card reaches review
unverified" switch is a policy, and policies belong to a human who has lived
with the thing for a fortnight first.

## Ratified

Alberto, 2026-07-31, both as recommended:

1. **D1 — argv arrays declared on the project.** Accepted with the cost stated:
   a compound check (`npm test && npm run lint`) must become a declared script
   first. The shell-string variant was rejected on the same ground that rejects
   the card-level one — `PUT /api/tracker` is unauthenticated, so a shell string
   in the document is a payload seam, and the flexibility is not worth it.
2. **D2 — a failing check leaves the card in `claude`/`working`.** Five statuses
   stay five; no `blocked` column, no schema migration, no transition rules to
   reconcile. A refuted card reads as what it is: still being worked on.
3. **D4 — 120s default stands**, deliberately short. The check that gates
   `done()` is the fast one; anything longer belongs in CI, not in a tool call.
