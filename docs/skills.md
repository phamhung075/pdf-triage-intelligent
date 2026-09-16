# 🧩 Skills — Unified Index

Single source of truth for methodology skills available to every agent. Backed by the vendored [obra/superpowers](../.claude/plugins/superpowers/) plugin, exposed under `docs/skills/` via a Windows directory junction so every SKILL.md is readable straight from the docs tree.

**Skills vs agent playbooks** (Golden mental model):
- **Skill** = *how* to work (process). Reusable across projects.
- **Agent playbook** ([docs/agents/](./agents/README.md)) = *what* to work on (PDF-triage domain).

Every agent must layer both — invoke the relevant skill AND follow its playbook.

## Repository-owned skills

This project's own procedures live in [`.agents/skills/`](../.agents/skills/) rather than here: they encode this repository's traps instead of reusable methodology, and each links out to the `docs/` file that owns its facts. Read the one whose trigger matches before acting.

| Skill | Load when |
| --- | --- |
| [pdf-triage-verify](../.agents/skills/pdf-triage-verify/SKILL.md) | Before claiming a change works, or before committing |
| [pdf-triage-change](../.agents/skills/pdf-triage-change/SKILL.md) | Finishing a notable change — docs, CHANGELOG, registering a doc or skill |
| [pdf-triage-personal-data](../.agents/skills/pdf-triage-personal-data/SKILL.md) | Touching prompts, classification rules, categories, dictionaries, fixtures |
| [pdf-triage-dispatch](../.agents/skills/pdf-triage-dispatch/SKILL.md) | Delegating work to a background DeepSeek worker |
| [pdf-triage-extraction](../.agents/skills/pdf-triage-extraction/SKILL.md) | Changing the extraction chain, OCR, the Docling layer or the quality gate |
| [pdf-triage-wsl-ops](../.agents/skills/pdf-triage-wsl-ops/SKILL.md) | Paths, ports, locks, or who runs the server |

Decision records — why a change went the way it did, and what lost — live in [`.agents/notes/`](../.agents/notes/README.md).

## Skills catalog

Read the linked SKILL.md before invoking.

### Meta / bootstrap

| Skill | When |
| --- | --- |
| [using-superpowers](./skills/using-superpowers/SKILL.md) | Start of ANY conversation — establishes how to find and use skills; requires skill invocation before ANY response including clarifying questions. Auto-triggered by the `SessionStart` hook. |
| [writing-skills](./skills/writing-skills/SKILL.md) | Creating new skills, editing existing ones, or verifying skills work before deployment. |

### Design & planning

| Skill | When |
| --- | --- |
| [brainstorming](./skills/brainstorming/SKILL.md) | Before ANY creative work — new feature, new component, added/modified behavior. Explores user intent + requirements + design before implementation. |
| [writing-plans](./skills/writing-plans/SKILL.md) | You have a spec or multi-step requirements — write the plan before touching code. |
| [executing-plans](./skills/executing-plans/SKILL.md) | You have a written implementation plan to execute in a separate session with review checkpoints. |

### Implementation

| Skill | When |
| --- | --- |
| [test-driven-development](./skills/test-driven-development/SKILL.md) | Implementing any feature or bugfix — RED → GREEN → REFACTOR before writing production code. |
| [systematic-debugging](./skills/systematic-debugging/SKILL.md) | Any bug, test failure, or unexpected behavior — before proposing fixes. |
| [subagent-driven-development](./skills/subagent-driven-development/SKILL.md) | Executing implementation plans with independent tasks in the current session. |
| [dispatching-parallel-agents](./skills/dispatching-parallel-agents/SKILL.md) | 2+ independent tasks that can be worked on without shared state or sequential dependencies. |
| [using-git-worktrees](./skills/using-git-worktrees/SKILL.md) | Starting feature work that needs isolation, or before executing implementation plans — isolated workspace via native tools or git worktree fallback. Note: PDF triage isn't yet a git repo; still useful once initialized. |

### Review & completion

| Skill | When |
| --- | --- |
| [verification-before-completion](./skills/verification-before-completion/SKILL.md) | About to claim work is complete, fixed, or passing — before committing or creating PRs. Evidence before assertions, always. |
| [requesting-code-review](./skills/requesting-code-review/SKILL.md) | Completing tasks, implementing major features, or before merging — verify work meets requirements. |
| [receiving-code-review](./skills/receiving-code-review/SKILL.md) | Receiving code review feedback before implementing suggestions — requires technical rigor and verification, not performative agreement. |
| [finishing-a-development-branch](./skills/finishing-a-development-branch/SKILL.md) | Implementation is complete, all tests pass, and you need to decide how to integrate the work. |

## Agent → skill affinity

| Agent | Default skill layer |
| --- | --- |
| [pipeline-engineer](./agents/pipeline-engineer.md) | brainstorming → writing-plans → TDD → systematic-debugging → verification-before-completion |
| [classification-expert](./agents/classification-expert.md) | brainstorming → writing-plans → verification-before-completion (sample real docs mentally) |
| [db-registry-keeper](./agents/db-registry-keeper.md) | writing-plans → TDD → verification-before-completion |
| [ui-frontend](./agents/ui-frontend.md) | brainstorming → writing-plans → verification-before-completion (browser smoke test) |
| [mcp-integrator](./agents/mcp-integrator.md) | writing-plans → TDD → verification-before-completion |
| [ollama-ops](./agents/ollama-ops.md) | systematic-debugging → verification-before-completion |
| [qa-reviewer](./agents/qa-reviewer.md) | requesting-code-review + receiving-code-review + verification-before-completion |
| [docs-curator](./agents/docs-curator.md) | writing-plans → verification-before-completion |

## Where skills physically live

- **Discoverable path** (auto-detected by Claude Code as project-level skills): `.claude/skills/` (junction).
- **Vendored source** (upstream): `.claude/plugins/superpowers/skills/` — cloned from [github.com/obra/superpowers](https://github.com/obra/superpowers) v6.2.0.
- **Docs-tree access** (this index): `docs/skills/` (junction → same target).

All three paths point to the SAME files. Edit once, seen everywhere. To update to a newer Superpowers release, `git pull` inside `.claude/plugins/superpowers/`.

## Vendor dev docs (out of scope)

The plugin also ships `.claude/plugins/superpowers/docs/` — Superpowers' own project history: porting guide, planning docs, specs. These are **vendor material**, not part of the PDF triage knowledge base. They're intentionally not surfaced here. Read them directly if you need to hack on the plugin itself.
