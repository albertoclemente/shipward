# Contributing

Thanks for looking. This is a small project with strong opinions, and the fastest
way to get a change merged is to know which opinions are load-bearing.

## Before anything else

```bash
node --test
```

That's the whole suite. It should be green before you start, so you can tell your
change from the weather. No install step — there are no dependencies.

Node 20 or newer, macOS or Linux.

## The one rule that isn't negotiable

**Nothing here may claim more than it can prove.**

That sounds like a slogan; in practice it decides code review. A pass says a
declared command exited zero on a named tree — not that the work is correct, and
the note says so in those words. If your change makes the tool assert something
it hasn't checked, it will be sent back even if the code is good.

Two habits follow from it:

- **Say "I don't know" as a distinct state.** Git that can't be read is not a
  repo with no branches. A note with no sha is not a fresh note. Wherever you add
  a check, the "couldn't tell" case needs its own answer, not a default.
- **Never truncate in silence.** If you cap a list, report what the cap dropped.
  An omission nobody mentions reads as full coverage.

## What good looks like here

**Pure rules, separate from I/O.** `git.mjs` reads git and nothing else;
`deriveFindings` holds every rule and touches nothing. `seed.mjs` is pure and
`setup.mjs` does the writing. Follow that split and your logic is testable
without a repository, a server or a clock.

**Comments explain why, not what.** The codebase is full of paragraphs about
incidents — a lock bug that lost writes, a check that ran for eighteen minutes
against a two-minute budget because the laptop lid was shut. Those are the most
valuable lines in the file. If your change fixes something surprising, write down
what surprised you.

**Tests assert the property, not the machine.** A test with a wall-clock ceiling
measures the CI runner's mood. Assert the thing you actually mean.

## Sending a change

1. Open an issue first for anything beyond a small fix — the answer may be "this
   is deliberate", and the reason will be interesting.
2. One change per pull request.
3. `node --test` green, with a test for what you changed.
4. Describe what you tried that *didn't* work. It's often the useful part.

Small, obvious fixes — a typo, a broken link, a confusing message — need no
issue. Just send them.

## Things this project has decided not to do

Not "not yet". Decided:

- **Dependency graphs, ready-work queues, leases, multi-agent coordination.**
  A different and worthwhile product. Competing there with a zero-dependency
  solo project loses.
- **Accounts, teams, permissions, hosted anything.** One developer, one machine.
- **Dependencies.** Zero, and it stays zero. If a change needs a package, it
  needs a different design.

## Security

The desk is an unauthenticated HTTP server on `127.0.0.1`. That's a deliberate
choice for a single-user local tool, and it's stated plainly in the README rather
than buried. It's also exactly why a check is an argv array declared by a human
in project config and never free text on a card.

Please report anything that lets the board grant a status it didn't verify, or
lets something reaching that port cause code to run, privately via GitHub's
security advisories rather than a public issue.
