# 🗂️ Project Overview — PDF Triage

## What it does

A **local-first** system that watches an input folder (`__raws`), extracts text from every PDF, classifies it with a local Ollama model (Qwen 3.5), writes the metadata into SQLite + a JSON registry mirror, and moves the physical file into a canonical `__archive/<category>/<subcategory>/<YYYY>/` folder. A web dashboard and an MCP server both sit on top of the same registry.

## Stack

| Layer         | Choice                                                      |
| ------------- | ----------------------------------------------------------- |
| Runtime       | Node.js (ESM) + TypeScript (tsx)                            |
| HTTP          | Express + CORS + SSE                                        |
| Storage       | SQLite (`sqlite`, `sqlite3`) + optional FTS5                |
| Local LLM     | Ollama `qwen3.5:9b` (+ `nomic-embed-text` for embeddings)   |
| PDF           | `pdf-parse`                                                 |
| Validation    | Zod                                                         |
| Agent bridge  | `@modelcontextprotocol/sdk` (stdio transport)               |
| UI            | Vanilla HTML/CSS/JS in `public/`                            |

## Entrypoints

- `npm run dev` / `npm start` — Web dashboard + REST + SSE + 10s auto-watcher (default).
- `npm run scan` — One-shot triage scan, exits.
- `npm run mcp` — MCP server on stdio.

`src/index.ts` dispatches on `process.argv[2]`.

## Data flow at a glance

```
__raws/*.pdf ──► extractPDFContent() ──► classifyPDFText() (Ollama)
                                            │
                                            ▼
                          insertDocumentRecord() (SQLite + FTS5)
                                            │
                                            ▼
                        relocalizeFileIfNeeded() ──► __archive/<cat>/<sub>/<YYYY>/
                                            │
                                            ▼
                            syncJSONRegistry() (registry.json)
                                            │
                                            ▼
                                broadcast SSE ──► Web UI
```

## Where things live on disk

- Project root: wherever you run the app from (`process.cwd()`), overridable via `PDF_TRIAGE_BASE_DIR`
- `__raws` (input): configurable via `settings.json` / `PDF_INPUT_DIR` — defaults to `<project-root>/input`
- `__archive` (output): configurable via `settings.json` / `PDF_OUTPUT_DIR` — defaults to `<project-root>/organized`
- SQLite: `pdf_triage.db`
- JSON mirror: `registry.json`
- Taxonomy: `categories.json`
- User config: `settings.json`
- Logs: `logs/triage_debug.log`

## Team model

Every agent playbook, workflow, and knowledge file lives in `docs/`. Agent shells in `.claude/agents/*.md` carry only a description; on invocation each agent lazy-loads its own playbook from `docs/agents/*.md`, which in turn links to the specific workflows and knowledge it needs.

See [Agent Roster](./agents/README.md) and [docs index](./README.md).
