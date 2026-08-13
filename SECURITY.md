# Security

Shipward runs commands on your machine. That is the entire feature, so it is
worth being precise about what protects you and what does not.

## Reporting something

Open a [private security advisory](https://github.com/albertoclemente/shipward/security/advisories/new).

If that link doesn't work — private reporting has to be switched on, and it may
not be yet — open a normal issue saying only that you've found something and
asking for a private channel. **Please don't put the details in a public
issue.**

I'm one person doing this in the evenings. You'll get an acknowledgement within
a few days, not within hours, and I'd rather say that than promise a response
time I can't keep.

## The model, in one paragraph

**One developer, one machine.** The desk is an HTTP server bound to `127.0.0.1`
with no authentication, and `PUT /api/tracker` rewrites the board. There are no
accounts, no permissions and no team features. That is the right shape for a
board on your own laptop and the wrong shape for a shared server — if you make
that port reachable by anything else, you have given whoever reaches it your
board.

## The one rule that carries the weight

A **check** is the command Shipward runs before it believes your agent. It is:

- an **argv array**, not a string, run with `shell: false` — so nothing inside
  it is ever parsed as shell syntax;
- **declared by a human**, by editing `.shipward/tracker.json`. The desk has no
  UI for it and never will;
- **selectable, never definable, by the agent.** `done` accepts a check *name*
  to choose among the ones you declared. No MCP tool and no CLI subcommand can
  write the checks map.

That separation is the product. An agent that could write the command that
grades it would be grading itself with extra steps.

A check also runs with **no `SHIPWARD_*` in its environment**, and with
`SHIPWARD_TRACKER` pinned to a path in the temp directory that does not exist.
A check that reaches for the board finds nothing and says so loudly, rather than
finding the live board — which is the shape of an incident that once replaced 32
cards.

## The part where I got it half wrong

I'd rather show you the failure than assert the principle.

**SW-043** closed the agent's door: checks became human-declared argv arrays that
no tool could write. I believed that was the whole problem.

**SW-064** was the other door, and it stayed open for weeks. `PUT /api/tracker`
replaces the *whole* document — including the checks map — and it is
unauthenticated by design. So anything that could reach the port could install
`["/bin/sh", "-c", "…"]` as a project's check, and the next `done()` would run
it. I reproduced it end to end on a sandbox board: `PUT` returned **200**, the
document was schema-valid because it genuinely *is* an array of strings, and the
next hand-back created the file the payload named.

Then I closed the card by mistake before fixing anything, noticed, and reopened
it. All of that is in the card's note, append-only, including the wrong move.

The fix: `PUT` now returns **403** for any change to a project's checks map,
comparing what arrives against what is on disk — so a faithful round-trip of the
board still works, and only an actual change is refused. Reproduced before and
after: the same request that returned 200 and executed `/bin/sh` now returns 403
with the checks map untouched.

**What generalises:** `shell: false` is no defence when the argv *is* a shell.
This was never an escaping problem. It is about which surface may **establish** a
command at all.

## What this does not protect you from

- **Everything else on the board is editable** by whatever can reach the desk
  port. Only the checks map is refused.
- **A check is only as good as the command you declared.** Shipward runs what you
  told it to run.
- **A pass proves a command exited zero on a named tree.** It does not prove the
  work is correct, and an agent that writes a passing test for broken code
  defeats this completely. Shipward says so in those words, on the card.
- **Anything you run it against.** Onboarding a repository wires hooks and an MCP
  server into it; onboard repositories you trust.

## Supported versions

`main`. This is a young project with one maintainer and no release branches —
fixes land on `main` and there is nothing older to back-port to.
