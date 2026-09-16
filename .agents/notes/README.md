# Agent Notes

One kind of design doc lives here. An **Agent Note** records a decision that affects this codebase — the *why*, and *what we gave up*. It is what [`CHANGELOG.md`](../../CHANGELOG.md) cannot carry: the changelog says what changed and when; an Agent Note says why it changed that way and which alternatives lost.

| Artifact | Question it answers |
| --- | --- |
| [`docs/`](../../docs/README.md) + [`AGENTS.md`](../../AGENTS.md) | How does this work **now**? |
| [`CHANGELOG.md`](../../CHANGELOG.md) | What changed, and when? |
| An Agent Note | Why this way, and what did we reject? |

An Agent Note is a design discussion record, not a status report. If nothing was given up and no alternative was plausible, the decision does not need one.

## Layout and naming

Every Agent Note encodes two axes in its **path**: `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`.

**Lifecycle** is the status, and the file moves between folders as that status changes:

- **`proposed/`** — a proposal reviewed before it is built. May speak in the future tense.
- **`implemented/`** — the decision shipped. Describes shipped reality in the present tense, and is **kept current**: when code later renames a file, changes a default or moves a mechanism, the note is updated in the same change to match the facts.
- **`rejected/`** — considered and declined. Keep one only while its rationale prevents a tempting mistake; otherwise delete the file.

The date is when the topic was **first proposed**. Cross-references between notes use relative Markdown links, never bare numbers, so they survive a move.

There is no `archived/` tree. That pattern exists in the project this convention is borrowed from to hold *frozen* records that a gate prevents from being edited; nothing here freezes or verifies them, so an obsolete implemented note is either updated, superseded, or deleted.

## Classification

Each note belongs to exactly one class:

| Class | What it covers |
| --- | --- |
| `feature` | A new user- or agent-facing capability. |
| `bug-fix` | Corrects a defect, or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behaviour or surface area without adding a capability. |
| `architecture` | A structural decision about the shipped source — how modules relate, what the vocabulary is. |
| `process` | Tooling, policy or workflow *around* the code — docs, gates, this system. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is the source we ship; **process** is the surrounding tooling. There is no `refactor` class — "does observable behaviour change?" already separates it from `simplification`.

## When to write one

Write one when the change alters behaviour, architecture, a contract shared across files, process or tooling, testing strategy, an on-disk or wire format, or any decision a maintainer may reasonably revisit. A proposal for substantial unbuilt work starts in `proposed/`; a decision already made starts in `implemented/`.

A purely mechanical or local edit — a typo, a rename with no behaviour change — is exempt. Updating the note that already owns a decision satisfies the rule; do not create a second note for the same decision.

An Agent Note is never edited into a *different* decision. Supersede it with a new note and cross-link both. Before deleting a fully superseded note, preserve anything still true — a surviving rationale, an alternative, a consequence — in the superseding note, and repair inbound links.

## The file format

The first three lines are exactly:

```markdown
# Agent Note: <title>

Status: <status>
```

followed by a blank line. `Status:` is one of `proposed`, `implemented`, or `rejected — <one-line why>`, and must agree with the folder the file sits in. The status carries no dates; the filename has the date and git has the rest. The rejection reason is the only status with content, because the verdict is what a reader comes for.

### Body

Every note opens with `## Problem` — the motivation, written so it stands without the solution. Then, by lifecycle:

**`implemented/`**

```markdown
## Problem
## Decision
…bespoke sections…
## Alternatives considered
## Consequences
```

`## Decision` is present tense about what shipped. `## Consequences` records what the trade-off cost **and** bought.

**`proposed/`**

```markdown
## Problem
## Proposal
…bespoke sections…
## Alternatives considered
## Acceptance criteria
## Risks
```

`## Acceptance criteria` states what observable result means done.

**`rejected/`**

The proposal frozen as written, whatever sections it had. The verdict lives on the `Status:` line.

### `## Alternatives considered` is mandatory

Each genuine alternative and why it lost, one bold-led paragraph or a `### Why not <X>?` subsection each. A decision recorded without what it beat invites the same argument again — which is the failure this whole system exists to prevent. Record alternatives; never invent them.

## Moving between lifecycles

A move updates `Status:` and re-satisfies the destination skeleton in the same change: `proposed/` → `implemented/` rewrites `## Proposal` into a present-tense `## Decision`, folds `## Acceptance criteria` and `## Risks` into `## Consequences` (or a present-tense `## Verification`), and drops plans for what actually shipped. `proposed/` → `rejected/` adds the reason to `Status:` and freezes the file.

## Language

English only. This repository has no translated documentation tree, so a note is a single file.
