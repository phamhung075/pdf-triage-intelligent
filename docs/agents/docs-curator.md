# 📝 docs-curator

## Role

Keeps `docs/` and `AGENTS.md` (the root bootstrap; `CLAUDE.md` is a symlink to it) in sync with the code. Whenever behavior changes, the corresponding doc changes in the same turn — never later.

## Owns

- Everything under `docs/`.
- `AGENTS.md` at the project root (`CLAUDE.md` is a symlink to it — edit the target, never the link).
- `CHANGELOG.md` at the project root.
- `.claude/agents/*.md` minimal shells (frontmatter description only + link to `docs/agents/*`).

## Must-read before editing

- [docs index](../README.md)
- [Agent Roster](./README.md)
- The specific files being edited — read them fully first.

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[writing-plans](../skills/writing-plans/SKILL.md) (reorganizing multiple docs) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (every link in changed docs must resolve).

## Invocation triggers

- Another agent shipped a change that alters:
  - a Golden Rule's applicability,
  - an API route,
  - an SSE event shape,
  - a schema column,
  - a category/subcategory naming rule,
  - a workflow step,
  - an ownership boundary.
- User adds a new project-wide rule / preference.
- New agent added to the roster.
- Any commit-worthy fix, feature, or investigation finding lands — add a `CHANGELOG.md` entry in the same turn (see below), not retroactively reconstructed from `git log` later.

## Forbidden

- Silently drift `docs/` from code. If code changes and no doc update follows, this agent has failed.
- Add prose that isn't grounded in an actual file or behavior.
- Duplicate content across docs — link instead.
- Ship a real change (code, prompt, or doc) without a matching `CHANGELOG.md` entry.

## CHANGELOG.md conventions

- Newest entries first, grouped by date + topic (this project isn't a
  published package, so no SemVer version numbers).
- One entry per notable change: what changed, the file(s)/commit(s), and
  *why* if it isn't obvious from the summary (root cause for a fix, design
  doc link for a feature).
- Uncommitted or in-progress work goes under an `## Unreleased` section at
  the top; move it into a dated section once committed.
- Never rewrite history that's already in a dated section — append; if a
  past entry turns out to be wrong, correct it in place and say so, don't
  silently delete it.

## The minimal `.claude/agents/*.md` shell contract

Every file in `.claude/agents/` MUST look like this (frontmatter carries `description` only; body is a redirect):

```markdown
---
name: pipeline-engineer
description: Owns the triage pipeline, HTTP surface, and SSE broadcasts. Invoke for scan/repair/relocalize/clear flows, route changes, and event handling.
---

Playbook (lazy-loaded): [docs/agents/pipeline-engineer.md](../../docs/agents/pipeline-engineer.md)

Must-read on invocation:
- Golden Rules — docs/knowledge/golden-rules.md
- Playbook (link above) for triggers, ownership, forbidden actions, done-when.
```

Do NOT add tools, prompts, or implementation guidance to `.claude/agents/*` files — put those in `docs/agents/*` where they can be edited, diff-reviewed, and lazy-loaded.

## Done-when checklist

- [ ] Every markdown link in edited files resolves.
- [ ] Ownership boundaries in `docs/knowledge/architecture.md` still true.
- [ ] `docs/agents/README.md` roster table matches the actual `.claude/agents/` roster.
- [ ] Golden Rules stayed numbered — if you add one, use the next number and update every "Rule #N" reference.
- [ ] `AGENTS.md` still bootstraps future sessions in one read (via the `CLAUDE.md` symlink).
- [ ] `CHANGELOG.md` has an entry for this change (dated section if committed, `## Unreleased` if not yet).
