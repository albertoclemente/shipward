Finish card $ARGUMENTS in .shipward/tracker.json:
1. Ensure work is committed; set "commit" to the latest short sha.
2. Move status to "review", claude "done"; append what changed + any decisions to "note".
3. Append a feed entry, then reply with a 3-line handoff: what changed, how to test, risks.
If the user said it's already deployed, use status "pushed" and set the "pushed" timestamp instead.