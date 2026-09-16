# Agent Note: adopt repository-owned agent skills and Agent Notes

Status: implemented

## Problem

Claude is now the orchestrator for this repository and delegates execution to DeepSeek Harness workers (see the Orchestrator section in [`AGENTS.md`](../../../../AGENTS.md)). Two gaps made that arrangement expensive and unreliable:

1. **There was no repository-owned skill.** [`docs/skills.md`](../../../../docs/skills.md) indexes only the fourteen vendored *superpowers* skills — generic methodology (brainstorming, TDD, systematic debugging) that knows nothing about `__raws`, the no-subcategory fail guard, or `public/ts` not recompiling. Every repository-specific procedure existed only as prose scattered across `docs/knowledge/`, `docs/workflows/` and the comment blocks of individual source files.
2. **There was no decision record.** [`CHANGELOG.md`](../../../../CHANGELOG.md) records what changed and when, never what was rejected or why. Incident postmortems — doc 5009's invisible malformed table rows, the 2026-08-31 filing of a SEPA mandate under invoices/cdiscount, the Windows-program-receives-`/mnt` path fallback — survive only as comments at the site of the fix, so a maintainer cannot find them and a plausible-but-wrong alternative can be re-proposed indefinitely.

A delegated worker inherits none of the orchestrator's context. Without a durable, linkable home for each rule, every work order had to restate the repository's constraints by hand, and a missed restatement produced a confident wrong result rather than an error.

## Decision

Adopt two structures under `.agents/`, modelled on the conventions used by DeepSeek Harness itself:

**Repository-owned skills** at `.agents/skills/<name>/SKILL.md`, each with `name` and `description` frontmatter whose description is the trigger line and opens with "Use when …". Six skills exist, each owning one procedure and linking out rather than restating `docs/`:

| Skill | Owns |
| --- | --- |
| `pdf-triage-verify` | The three gates and which apply; the `public/js` regeneration trap |
| `pdf-triage-change` | The `AGENTS.md` + `docs/` + `CHANGELOG.md` same-turn rule, doc and skill registration |
| `pdf-triage-personal-data` | The public-base/private-overlay split and what may never be committed |
| `pdf-triage-dispatch` | Writing a work order a DeepSeek worker can execute without reading the repository |
| `pdf-triage-extraction` | The three-extractor chain, the Docling gate, OCR degradation, the quality gate |
| `pdf-triage-wsl-ops` | POSIX↔Windows path discipline, server ownership, locks, ports |

They are referenced from `AGENTS.md` and from `docs/skills.md`. Claude Code does **not** auto-discover them: project skill auto-discovery reads `.claude/skills/`, which in this repository is a directory junction into the vendored superpowers plugin, and is gitignored besides.

**Agent Notes** at `.agents/notes/{proposed,implemented,rejected}/{feature,bug-fix,simplification,architecture,process,testing}/yyyy-mm-dd-topic-title.md`, with the convention in [`.agents/notes/README.md`](../../README.md). A note carries `## Problem`, `## Decision`, a mandatory `## Alternatives considered`, and `## Consequences`; it is kept current with what shipped, and a reversed decision is superseded by a new note rather than rewritten.

## Alternatives considered

**Keep everything in `docs/` and add nothing.** Rejected: `docs/` describes current state and is written to be read linearly by an agent that already has the repository open. The two things missing are different in kind — a *trigger* ("when this situation arises, do this") and a *rejected alternative* ("we tried this, it failed because"). Folding them into `docs/knowledge/` would either bloat files whose job is to be loaded whole, or bury them where nobody looks.

**Copy DeepSeek Harness's bilingual triplets and its gate scripts.** Rejected. Every DSH note ships with a `.zh.md` counterpart and an `.i18n.yaml` hash record, enforced by `verify-translation-pairing`; and its `archived/` tree is protected by a frozen-content manifest checked in CI. This repository is English-only with no gate runner. Adopting the ceremony without the enforcement would produce sidecar files that rot and an archive nobody verifies — so there is no `archived/` tree here, and the README says why.

**Restructure `.claude/skills` into a real directory holding a link to the vendored plugin plus the repository's own skills.** Rejected: it would make Claude Code auto-discover the skills, but it rewires the path the vendored plugin is loaded through — a third-party tree this repository does not own and already cannot commit (`.gitignore` excludes `.claude/skills`). The cost is real and accepted: discovery goes through the `AGENTS.md` pointer instead.

**Write the skills inside the vendored superpowers plugin.** Rejected outright: `.claude/plugins/superpowers/` is third-party material under its own licence, cloned rather than vendored, and already the subject of a licensing decision that keeps its content out of this repository's committed source.

**One skill per documentation file.** Rejected: it would restate `docs/knowledge/*` under a second filename, and the two copies would diverge. Each skill here owns a *procedure* and links to the docs for the facts.

## Consequences

**Bought.** Every repository-specific rule now has one addressable home that a work order can name — a dispatch prompt cites `.agents/skills/pdf-triage-verify/SKILL.md` instead of restating three commands and their traps. The rejected alternatives behind doc 5009's quality gate, the `scope: 'filename'` rule, and the WSL path fallback are written down once, so they can be linked rather than re-derived. Adding a rule now has an obvious destination: an anchor in `AGENTS.md` if it is absolute, a `docs/` section if it is a fact, a skill if it is a procedure, a note if it is a decision.

**Cost.** One more place to look, and a maintenance obligation: a skill that describes a changed command is worse than no skill, so [pdf-triage-change](../../../skills/pdf-triage-change/SKILL.md) makes updating the affected skill part of finishing a change. Two of the six skills duplicate a fact that already existed as a source-file comment header (`extraction-quality-gate.ts`, `os-open.ts`) — deliberately, because those headers are only read by someone already editing that file, which is exactly the audience that does not need the warning.

**Not covered.** Nothing enforces any of this: no gate checks that a `SKILL.md` has valid frontmatter, that a note's `Status:` matches its folder, or that a change touched the docs. The DeepSeek Harness keeps that honest with `verify-agent-note-format`, `verify-md-links` and `verify-export-jsdoc`; this repository relies on the `qa-reviewer` playbook instead. If drift appears, the honest fix is a gate, not more prose.
