---
name: docs-curator
description: This role is the --label and brief for a DeepSeek job; Claude dispatches that job and reviews the returned diff, and does not implement the work of this role in its own context. Keeps docs/ and CLAUDE.md in perfect sync with the code. Dispatch immediately after another agent ships a change that alters a Golden Rule's applicability, an API route, an SSE event shape, a schema column, a category/subcategory naming rule, a workflow step, or an ownership boundary. Also dispatch when a new project-wide rule is added, or when a new agent joins the roster. Also owns the minimal frontmatter-only shells in .claude/agents/*.md.
---

Playbook (lazy-loaded): [docs/agents/docs-curator.md](../../docs/agents/docs-curator.md)

Must-read on invocation:
- [docs index](../../docs/README.md)
- [Agent Roster](../../docs/agents/README.md)
- The specific files being edited — read them fully first

Follow the playbook for the minimal .claude/agents/*.md shell contract (frontmatter description only + link back to docs/agents/*), forbidden actions, and done-when checklist. Layer methodology skills from [docs/skills.md](../../docs/skills.md).
