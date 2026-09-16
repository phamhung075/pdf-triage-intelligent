# AGENTS.md — Agent Notes

Agent Notes are durable decision records written by agents: they preserve the rationale, the alternatives that lost, the consequences, and what verification pins the result. Follow the [Agent Note rules](README.md) and the documentation discipline in the [root instructions](../../AGENTS.md).

**Every new Agent Note triggers a supersession check.** Search the active tree for older notes covering the same decision or mechanism before writing a new one. If an existing note owns the decision, update it instead of duplicating it. If your change reverses a decision, write a new note and cross-link both rather than rewriting the old one — a superseded note is deleted only once everything still true has been carried into its successor.

Keep an `implemented/` note current with what actually shipped: rewrite stale paths, symbol names and defaults in place as it changes. Updating facts is required; rewriting the decision is not permitted.
