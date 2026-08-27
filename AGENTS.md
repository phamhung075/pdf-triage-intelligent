# 🤖 AGENTS.md — Agent Instructions, Bootstrap & Lazy-Loading Context

> **This file is the single root bootstrap for every agent.** `CLAUDE.md` at the project root is a
> **symlink → `AGENTS.md`**, so Claude Code, Codex, Cursor and any other agent tool all read exactly
> the same instructions.
>
> **Lazy-loading by design**: this file stays small on purpose. The full, detailed knowledge lives in
> `docs/` and is loaded **only when you need it** — the context map below tells you which file to open
> for which topic. Do not re-state doc content in this file; link to it.
>
> Together, `AGENTS.md` + `docs/` are the single source of truth for how this project works *now*;
> [CHANGELOG.md](CHANGELOG.md) is the dated record of how it got there — every notable change updates
> both in the same turn.

---

## 🧠 Golden Rule: Think First Before Action

> ⚠️ **THINK FIRST BEFORE DOING ANYTHING**: Always thoroughly analyze the problem, inspect the
> codebase, trace imports, verify data schemas, and plan your implementation steps carefully before
> editing files or running commands. Never make assumptions or guess implementation details.

---

## 📥 Lazy-Loading Context Map

> **CRITICAL**: Before performing any task, code edit, or server command in this repository, you MUST
> read and obey all specifications defined in the files below.

### Must read, every session

| Topic | File |
| --- | --- |
| Authoritative user spec (all master directives) | [AGENT_REQUIREMENTS.md](./AGENT_REQUIREMENTS.md) |
| The 21 non-negotiable Golden Rules (rules override everything) | [docs/knowledge/golden-rules.md](docs/knowledge/golden-rules.md) |
| Docs index — all knowledge, workflows, agent playbooks | [docs/README.md](docs/README.md) |
| Agent roster — who owns what, when to invoke each | [docs/agents/README.md](docs/agents/README.md) |

### On-demand (lazy-load only when the topic is relevant)

| Topic | File |
| --- | --- |
| Classification decision flow — strict priority order (banks first, Step 0 overlay) | [docs/workflows/classification-flow.md](docs/workflows/classification-flow.md) |
| Architecture & module boundaries | [docs/knowledge/architecture.md](docs/knowledge/architecture.md) |
| Data model — SQLite schema, `categories.json`, `registry.json` | [docs/knowledge/data-model.md](docs/knowledge/data-model.md) |
| Ollama / Qwen 3.5 — prompt design, JSON contract, fallbacks | [docs/knowledge/ollama-qwen.md](docs/knowledge/ollama-qwen.md) |
| On-disk canonical folder layout & naming | [docs/knowledge/canonical-paths.md](docs/knowledge/canonical-paths.md) |
| REST + SSE + MCP API reference | [docs/knowledge/api-reference.md](docs/knowledge/api-reference.md) |
| Taxonomy — categories, subcategories, private overlays | [docs/knowledge/taxonomy.md](docs/knowledge/taxonomy.md) |
| Environment & config (`settings.json`, env vars) | [docs/knowledge/environment.md](docs/knowledge/environment.md) |
| Workflows — triage, repair, relocalize, clear, SSE broadcast | [docs/workflows/](docs/workflows/) |
| Skills index — methodology (Superpowers plugin) | [docs/skills.md](docs/skills.md) |
| Per-agent playbooks (lazy-loaded on invocation) | [docs/agents/](docs/agents/) |

---

## 🚀 What this project is

Local-first **PDF Triage & Agentic Registry** — TypeScript + Node.js + Express + SQLite (+FTS5) + Ollama Qwen 3.5. Watches `__raws`, extracts text, classifies each document, writes SQLite + JSON registry mirrors, moves the file to a canonical `__archive/<category>/<subcategory>/<YYYY>/` folder, and pushes SSE updates to a web dashboard. Also exposes MCP tools for external agents.

Incoming **photos** (`.jpg/.png/.webp/.bmp/.tiff`) are not archived as images: they run through the vision pipeline (orient → crop → enhance → OCR) and are filed as A4 PDFs — see `src/application/convert-image-document.ts`. A **folder** in `__raws` holding only photos (2+) is bundled into ONE multi-page PDF named after the folder, pages ordered numerically (`IMG_2` before `IMG_10`); a lone photo, or a folder mixing photos with anything else, is triaged file-by-file as before. OCR is **PaddleOCR first** (local FastAPI service in `paddleocr-server/`), with Tesseract.js as an availability fallback.

Full overview: [docs/overview.md](docs/overview.md).

---

## ⛔ Non-negotiable rules (one-line anchors — full detail is lazy-loaded from [Golden Rules](docs/knowledge/golden-rules.md))

These are the memory anchors that must never be forgotten, even before loading the full rules:

1. **Think first** — read code, trace imports, verify schemas before editing. No guessing paths or field names. *(Golden Rule 0)*
2. **Server command rule** — **NEVER** run `npm run dev` or any server background task yourself. Always ask/instruct the user to run it in their terminal. *(Golden Rule 2)*
3. **Scan scope** — scan **ONLY** inside `__raws` (`CONFIG.INPUT_DIR`). Never full-disk / parent walks. *(Golden Rule 1)*
4. **No-text block guard** — a PDF with `< 10` clean characters is BLOCKED: no DB row, no move, stays in `__raws`, emit `FILE_FAILED`. *(Golden Rule 3)*
5. **STRICT no-subcategory fail guard** — resolving to empty / `general` / `other` / `divers` / a year-string → **FAILED / BLOCKED**: no SQLite row, no move, **MUST remain in `__raws`** for manual review. *(Golden Rule 4)*
6. **Pre-move dynamic auto-creation (zero-block)** — BEFORE moving a file, register any missing category/subcategory **in `.categories.private.json`** (never the committed `categories.json`), then construct folders and move. *(Golden Rule 5)*
7. **Deep semantic reading over keywords** — analyze full semantic context, legal purpose, and primary issuing entity. Never classify off a lone keyword (a `SFR`/`PayPal` row inside a Crédit Mutuel statement is a transaction, not the document type). *(Golden Rule 6)*
8. **Company-level separation** — never lump: `credit_mutuel` ≠ `societe_generale` ≠ generic `banque`. Same rule for employers, insurers, health institutions, schools, vendors. *(Golden Rule 7)*
9. **Classification decision flow** — strict priority order, Step 0 private overlay first, banks always win → see [classification-flow.md](docs/workflows/classification-flow.md). *(Golden Rule 6/7)*
10. **Executive summary contract** — 3–5 searchable sentences per document: issuing organization, key identifiers/refs, financial amounts/dates, core purpose. Written to `summary`, indexed in SQLite FTS5. *(Golden Rule 12)*
11. **SSE on every mutation** — scan / relocalize / edit / repair / clear / watcher tick all broadcast live SSE. *(Golden Rule 10)*
12. **Clear Registry semantics** — `DELETE /api/documents` moves every `__archive` file back to `__raws`, cleans empty folders, purges the SQLite DB. *(Golden Rule 15)*
13. **Toast only** — all UI feedback via Toast service, never `alert()`. *(Golden Rule 13)*
14. **Only Qwen 3.5** — `qwen3.5:9b`. Legacy models are purged; do not reintroduce. *(Golden Rule 14)*
15. **Personal-data hygiene** — never hardcode personal data in committed `prompts/` or `src/domain/classification.ts`. Real employers, bank product/filename codes, clinics, schools, scanner prefixes go in the gitignored `.prompts.private.json`, which feeds BOTH the prompt (`{{USER_PRIORITY_RULES}}` / `{{USER_KNOWN_ENTITIES}}`) and `ruleBasedClassify()` via `matchPriorityRules()` — one source keeps them aligned. `src/domain/prompt-hygiene.test.ts` fails the build on a leak. *(see [taxonomy.md](docs/knowledge/taxonomy.md#personal-prompt-overlay))*
16. **No speculative DDD scaffolding** — do NOT reintroduce a DI container, aggregate classes, a domain-event bus, a unit of work, or a command/query dispatcher. The wired 3-layer design (`index.ts` → `http/web-server.ts` → `application/*` → `domain/*` + `infrastructure/*`) plus parameter-injected, unit-tested domain functions is the architecture; `index.ts` is the composition root; the SSE broadcast callback is the event mechanism. *(see [architecture.md](docs/knowledge/architecture.md))*
17. **Photo-pipeline invariants** — never re-apply EXIF orientation (`exifDegrees` is `null` by design), never reintroduce the crop-detector texture gate (the signal is inverted on half the corpus), never delete a source image (move it to `__raws/.delete_files/img_converted/`; conversion is an enhancement, never a gate). *(see headers of `src/domain/flood-crop.ts` and `src/application/convert-image-document.ts`)*

---

## 👥 Team (lazy-loaded)

The roster, ownership table, and invocation etiquette live in [docs/agents/README.md](docs/agents/README.md) — load it before spawning or joining an agent team.

Shells in `.claude/agents/*.md` are **description-only frontmatter** linking to the full playbooks in `docs/agents/*.md`: agents load only the description upfront, then lazy-load their playbook + required knowledge on invocation. All operational knowledge is diff-friendly and lives in one place.

---

## 🛠️ Skills (single source: docs/skills.md)

The [obra/superpowers](https://github.com/obra/superpowers) plugin (v6.2.0) is vendored at [`.claude/plugins/superpowers/`](.claude/plugins/superpowers/) and exposed via Windows directory junctions:
- [`.claude/skills/`](.claude/skills/) — Claude Code auto-discovery path.
- [`docs/skills/`](docs/skills/) — same target, accessible from the docs tree.

**Single source of truth for skills**: [`docs/skills.md`](docs/skills.md) — indexed catalog with per-agent affinity table. The plugin is registered as `superpowers@superpowers-dev` in [`.claude/settings.json`](.claude/settings.json); a `SessionStart` hook auto-invokes `using-superpowers` on startup/clear/compact.

**Rule of thumb**: Skills are HOW to work; agent playbooks are WHAT to work on. Layer both. (`.claude/plugins/superpowers/docs/` is vendor material — intentionally NOT merged into `docs/`.)

---

## 🗂️ Repo layout

```
pdf_triage/
├── AGENTS.md                  # THIS file — single root bootstrap for all agents (instructions + lazy-loading map)
├── CLAUDE.md                  # symlink → AGENTS.md (Claude Code reads the same file)
├── CHANGELOG.md               # dated, grouped record of every notable change — updated alongside docs/code
├── AGENT_REQUIREMENTS.md      # user-authored full spec (authoritative — must-read)
├── LICENSE                    # MIT
├── categories.json            # PUBLIC, generic starter taxonomy (committed) — top-level categories only
├── .categories.private.json   # PRIVATE taxonomy overlay (gitignored) — real auto-created subcategories; merged with categories.json at runtime by categories-store.ts
├── entity_dictionary.json     # curated generic entity reference (banks, telecoms, etc.) — safe to commit, not personal
├── prompts.private.json.example # committed template for .prompts.private.json
├── .prompts.private.json      # PRIVATE prompt overlay (gitignored) — your real employers, bank product/filename codes, clinics, scanner prefixes; injected into the generic prompts/ templates at build time by prompt-personalization-store.ts
├── settings.json               # runtime config (gitignored — contains real folder paths); see settings.json.example for the template
├── settings.json.example      # committed template for settings.json
├── .env.example                # committed template for .env (gitignored) — BASE_DIR override, ports, Ollama host, etc.
├── pdf_triage.db               # SQLite (runtime, gitignored)
├── registry.json               # JSON mirror (runtime, gitignored)
├── package.json                # tsx dev + build scripts
├── docs/                      # → knowledge, workflows, agent playbooks (LAZY-LOADED — see context map above)
│   ├── README.md
│   ├── overview.md
│   ├── skills.md              # UNIFIED skill index (single source of truth)
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   ├── agents/{README,*.md}   # per-agent playbooks
│   ├── knowledge/*.md         # architecture, data-model, ollama-qwen, canonical-paths, api-reference, taxonomy, environment, golden-rules
│   └── workflows/*.md         # triage-pipeline, repair-registry, relocalize, clear-registry, classification-flow, sse-broadcast
├── .claude/
│   ├── settings.json          # enables superpowers plugin locally
│   ├── agents/*.md            # description-only shells → link to docs/agents/*
│   ├── skills/                # junction → .claude/plugins/superpowers/skills
│   └── plugins/
│       └── superpowers/       # full obra/superpowers repo, cloned
├── src/
│   ├── index.ts                       # composition root: dispatch default web, `scan`, `mcp`
│   ├── vision-lab-server.ts           # Vision Lab standalone Express app: POST /api/vision/diagnose-step, own port
│   ├── vision-lab-main.ts             # Vision Lab entrypoint: calls startVisionLabServer() — `npm run vision:dev`
│   ├── domain/                        # pure logic, zero I/O
│   │   ├── document.schema.ts         # Zod schemas
│   │   ├── classification.ts          # ruleBasedClassify, cleanAndParseJSON, entity matching, normalizeSlug
│   │   ├── prompt.ts                  # Qwen prompt building (Step A/C/D)
│   │   ├── prompt-personalization.ts  # schema + rendering for the private prompt overlay (.prompts.private.json)
│   │   ├── classification-resolution.ts  # refine/resolve category & subcategory, entity-priority override
│   │   ├── taxonomy.ts                # isForbiddenSubcategory, computeCanonicalPath
│   │   ├── pdf-text.ts                # cleanExtractedText
│   │   ├── pdf-page-fit.ts            # fitImageToA4 — pure page geometry for photo-to-PDF pages
│   │   ├── image-adjust.ts            # pure auto-levels/sharpen math for the Vision Lab pipeline (ported from pdf-awesome)
│   │   └── path-conversion.ts         # windowsToWslPath / wslToWindowsPath / isWslMountPath — pure WSL↔Windows path forms (Golden Rule 21)
│   ├── application/                   # orchestration / use-cases
│   │   ├── classify-document.ts       # classifyPDFText orchestrator (Step A entity + Step C markdown + Step D classify)
│   │   ├── triage-scan.ts             # runTriageScan — the real, live-wired scan pipeline
│   │   ├── ai-chat-assistant.ts       # local chat assistant grounded in the document registry (via MCP prepare_dossier)
│   │   ├── image-to-pdf.ts            # Vision Lab step functions: runOrientStep/runCropStep/runEnhanceStep/runExtractStep
│   │   ├── convert-image-document.ts  # convertImageToPdf — photo in __raws -> archivable A4 PDF + its OCR text (used by triage-scan); source photo kept in .delete_files/img_converted
│   │   ├── repair-registry.ts
│   │   ├── relocalize-document.ts
│   │   ├── clear-registry.ts
│   │   ├── scan-lock.ts
│   └── infrastructure/                # I/O adapters
│       ├── settings.ts                # CONFIG, BASE_DIR (defaults to process.cwd(), overridable via PDF_TRIAGE_BASE_DIR)
│       ├── os-open.ts                 # the ONLY module that launches Explorer/Chrome — WSL-safe, see Golden Rule 21
│       ├── logger.ts
│       ├── categories-store.ts        # merges categories.json (public) + .categories.private.json (private) on read; diffs writes to the private file only
│       ├── entity-dictionary-store.ts # entity_dictionary.json read
│       ├── prompt-personalization-store.ts # .prompts.private.json read (personal prompt overlay)
│       ├── manual-decisions-store.ts  # manual_decisions.json read/write (user feedback log, gitignored)
│       ├── zip-builder.ts             # pure-TS ZIP archive builder (no native deps) — PDF package export + bulk Markdown export
│       ├── ollama-client.ts
│       ├── vision-client.ts           # detectOrientation/detectCropBox — Ollama calls against CONFIG.OLLAMA_VISION_MODEL
│       ├── paddleocr-client.ts        # paddleOcrRecognize/paddleOcrDetectOrientation — HTTP client for paddleocr-server/, auto-spawns it if unreachable
│       ├── image-processor.ts         # @napi-rs/canvas ops: rotateImage, cropImage, applyBrightnessContrast, applySharpen
│       ├── pdf-extractor.ts
│       ├── pdf-scanner.ts
│       ├── pid-lock.ts
│       ├── db/database.ts
│       ├── json-registry.ts
│       ├── http/web-server.ts         # all real REST/SSE routes live here
│       └── mcp/mcp-server.ts
├── public/                    # UI — public/ts/ (source) compiled to public/js/ (served), public/scss/ (source) compiled to public/style.css (served), public/js/vendor/ (marked.js, vendored not CDN)
│   └── test-image-to-pdf.html # standalone Vision Lab diagnostic page (served by vision-lab-server.ts, not the main app)
├── paddleocr-server/           # standalone Python/FastAPI OCR service (PaddleOCR) — separate process, see paddleocr-server/README.md
├── social/                    # gitignored — LinkedIn/marketing drafts, not project source
└── logs/triage_debug.log
```

---

## 📜 Scripts

- `npm run dev` / `npm start` — dev server (web + SSE + 10s auto-watcher). **User runs this, not the agent.**
- `npm run scan` — one-shot triage scan.
- `npm run mcp` — MCP stdio server.
- `npm run vision:dev` — standalone Vision Lab diagnostic server (port `3179`), run independently of `npm run dev`.
- `npm run build` — `clean:dist` + `build:css` + `tsc` (backend) + `tsc -p tsconfig.frontend.json` (frontend).
- `npm run clean:dist` — removes `dist/`. Runs first in `build` because `tsc` never prunes output for
  deleted sources, and `package.json`'s `build.files` ships `dist/**/*` — so orphaned `.js` from a
  removed module would otherwise be packaged into the `.exe` forever.
- `npm run build:css` — compile `public/scss/style.scss` → `public/style.css`.
- `npm run watch:css` — `sass --watch` for local SCSS development.
- `npm run build:frontend` — `build:css` + compile `public/ts/*.ts` → `public/js/*.js`. Run this after editing any `public/ts/*.ts` file — nothing recompiles it automatically.
- `npm run watch:frontend` — `tsc -p tsconfig.frontend.json -w` for local frontend development.
- `npm run typecheck` — `tsc -p tsconfig.test.json` + `tsc -p tsconfig.frontend.json`, no emit.
- `npm run desktop` — Electron desktop shell.
- `npm run dist:exe` — build the portable Windows installer.
- `npm test` — run the Vitest unit test suite (pure classification/path/schema logic; see `docs/superpowers/specs/2026-07-31-test-harness-design.md`).
- `npm run test:watch` — Vitest in watch mode for local development.
