# 🗂️ Project Overview — PDF Triage

## What it does

A **local-first** system that watches an input folder (`__raws`), extracts text from every PDF, classifies it with a local Ollama model (Qwen 3.5), writes the metadata into SQLite + a JSON registry mirror, and moves the physical file into a canonical `__archive/<category>/<subcategory>/<YYYY>/` folder. A web dashboard and an MCP server both sit on top of the same registry.

The backend is **one static, CGO-free Go binary**, `pdf-triage`, exposing `serve | scan | mcp |
vision-lab`. Text extraction is delegated to the external, self-hosted **pdf2w** service; canonical
path resolution and text cleaning run in-process. TypeScript remains only for the browser dashboard
(`public/ts` → `public/js`, SCSS → `public/style.css`).

## Stack

| Layer         | Choice                                                      |
| ------------- | ----------------------------------------------------------- |
| Runtime       | Go 1.23, one static CGO-free binary `pdf-triage` (`make build` → `dist/pdf-triage`) |
| HTTP          | Go stdlib `net/http` + SSE (`httpapi` package)              |
| Storage       | SQLite via `modernc.org/sqlite` (pure Go) + optional FTS5  |
| Local LLM     | Ollama `qwen3.5:9b` (+ `nomic-embed-text` for embeddings)   |
| PDF           | `github.com/pdfcpu/pdfcpu` (assemble / merge / split), `golang.org/x/image` (decode/encode) |
| Validation    | `documentschema` package                                    |
| Agent bridge  | `github.com/modelcontextprotocol/go-sdk` v1.3.1 (stdio + streamable HTTP) |
| Extraction    | external, self-hosted pdf2w (`PDF2W_SERVICE_URL`)           |
| UI            | Vanilla HTML/CSS/TypeScript in `public/` (built with pnpm + sass + tsc) |

## Entrypoints

All four are subcommands of the one binary, dispatched by `cmd/pdf-triage`:

- `./dist/pdf-triage serve` — Web dashboard + REST + SSE + 10s auto-watcher (the default when no subcommand is given).
- `./dist/pdf-triage scan` — One-shot triage scan, exits.
- `./dist/pdf-triage mcp` — MCP server (stdio + streamable HTTP).
- `./dist/pdf-triage vision-lab` — Standalone Vision Lab diagnostic server.

`make build` compiles the binary (and builds the dashboard assets); `make test` runs the Go suite.

## Data flow at a glance

```
__raws/*.pdf ──► extractPDFContent() ──► classifyPDFText() (Ollama)
                                             │
                                             ▼
                           insertDocumentRecord() (SQLite + FTS5)
                                             │
                                             ▼
      relocalizeFileIfNeeded() (canonicalpath in-process) ──► __archive/<cat>/<sub>/<YYYY>/
                                             │
                                             ▼
                             syncJSONRegistry() (registry.json)
                                             │
                                             ▼
                                 broadcast SSE ──► Web UI
```

## Where things live on disk

- Project root: wherever the binary is run from (its working directory), overridable via `PDF_TRIAGE_BASE_DIR`
- `DATA_DIR`: writable state root, defaults to `PDF_TRIAGE_BASE_DIR` (`PDF_TRIAGE_DATA_DIR`)
- `__raws` (input): configurable via `settings.json` / `PDF_INPUT_DIR` — defaults to `<BASE_DIR>/input`
- `__archive` (output): configurable via `settings.json` / `PDF_OUTPUT_DIR` — defaults to `<BASE_DIR>/organized`
- SQLite: `pdf_triage.db`
- JSON mirror: `registry.json`
- Taxonomy: `categories.json`
- User config: `settings.json`
- Logs: `DATA_DIR/logs/triage_debug.log`

## Team model

Every agent playbook, workflow, and knowledge file lives in `docs/`. Agent shells in `.claude/agents/*.md` carry only a description; on invocation each agent lazy-loads its own playbook from `docs/agents/*.md`, which in turn links to the specific workflows and knowledge it needs.

See [Agent Roster](./agents/README.md) and [docs index](./README.md).
