---
name: pdf-triage-change
description: Use when finishing any notable change to pdf-triage — it owns the AGENTS.md + docs/ + CHANGELOG.md single-source-of-truth rule, where a new doc or skill gets registered, and the difference between current-state prose and history.
---

# Recording a change in pdf-triage

This repository keeps one fact in one place, and every notable change lands in **three** places in the **same turn** — never reconstructed later from `git log`.

| Artifact | Holds | Tense |
| --- | --- | --- |
| [`AGENTS.md`](../../../AGENTS.md) | The root bootstrap: golden-rule anchors + the lazy-loading map. **Stays small.** | current |
| [`docs/`](../../../docs/README.md) | The detail — `knowledge/`, `workflows/`, `agents/` playbooks. | current |
| [`CHANGELOG.md`](../../../CHANGELOG.md) | Dated, grouped record of what changed and when. | history |
| [`.agents/notes/`](../../notes/README.md) | The *why* and *what was rejected*, for decisions a maintainer may revisit. | current |

`AGENTS.md`, `docs/` and `CHANGELOG.md` describe how the project works **now**; the changelog is how it got there; an Agent Note is the reasoning that produced it. `CLAUDE.md` is a symlink to `AGENTS.md` — edit the real file.

## Is this change "notable"?

Update the set when the change alters any of: observable behavior, a REST/SSE/MCP endpoint, an env var or `settings.json` key, the SQLite schema or a Zod contract, the on-disk folder shape, the prompt contract, a gate or test strategy, or a rule in this repository's non-negotiable list.

A purely local edit — a typo, a rename with no behavior change, a test-only refactor — is exempt. Do not add a changelog entry for it.

## AGENTS.md: link, never restate

`AGENTS.md` is the *bootstrap*, loaded every session. Its own header states the rule: **do not re-state doc content in this file; link to it.** When you add a doc under `docs/`, add one row to the right lazy-loading map table (Must-read vs On-demand) and put the detail in the doc.

Resist adding to the numbered non-negotiable list. Those are memory anchors, one line each, each cross-linked to the Golden Rule it summarises. A new *detail* belongs in `docs/`; a new *absolute constraint* belongs in the list **and** in [`docs/knowledge/golden-rules.md`](../../../docs/knowledge/golden-rules.md), which is the fuller statement.

## Register a new document

A doc that no index links is a doc nobody loads. When adding one:

1. Add it to [`docs/README.md`](../../../docs/README.md) — the index has one section per kind (`Workflows`, `Knowledge Base`, `Agent Playbooks`); a new file needs a line with a one-phrase description.
2. Add the same row to the `AGENTS.md` lazy-loading map if an agent should load it on demand.
3. If it changes what an agent should *do*, add the trigger to that agent's playbook in `docs/agents/`.

An **agent playbook** is `docs/agents/<role>.md`; `.claude/agents/<role>.md` is a description-only frontmatter shell that links to it, so the roster stays diff-friendly. Edit the playbook, not the shell.

## Register a new skill

Project-owned skills live in [`.agents/skills/<name>/SKILL.md`](../) with `name` and `description` frontmatter; the description is the trigger line, so it opens with "Use when …". Link the skill from [`docs/skills.md`](../../../docs/skills.md) so the existing skills index is not a dead end, and from the `AGENTS.md` map when it should load automatically.

The vendored superpowers skills under `docs/skills/` (a junction into `.claude/plugins/superpowers/`) are third-party methodology — read them, do not edit them here. **Skill = how to work. Agent playbook = what to work on.** Layer both.

## The changelog entry

Group by date and topic, newest first, matching the existing `## Unreleased` → `### <topic>` shape. Write it for a reader deciding whether this affects them: what changed, where, and what the consequence is — not a file-by-file diff. Link the commit once it exists. The entry is written with the change, not after it.

## Before you commit

Run the [pdf-triage-verify](../pdf-triage-verify/SKILL.md) gates for whatever you touched, and run the [pdf-triage-personal-data](../pdf-triage-personal-data/SKILL.md) check if the change touches `prompts/`, `src/domain/classification.ts`, `categories.json`, or anything that could carry a real employer, bank, clinic, school or filename prefix.
