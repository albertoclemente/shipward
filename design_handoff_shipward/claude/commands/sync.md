Audit .shipward/tracker.json against reality (git log, branches, deploy state) for the active project:
- cards in "claude" with no matching branch or recent commits → flag or move back to "backlog"
- merged/deployed branches whose cards aren't "pushed" → update status + timestamps + commit
- work visible in git but missing from the tracker → create cards
Apply the fixes, append one feed entry summarizing the sync, and report what changed.