# Agent Note: retire the TypeScript backend for one Go binary

Status: implemented

## Problem

The pdf-triage backend had grown as a TypeScript/Node application (`src/`, 8,288 non-test lines
across 35 application + infrastructure modules) whose runtime value was thin: every application
module was asynchronous orchestration over filesystem / HTTP / SQLite, and the only genuinely
CPU-heavy engine — extraction — already lived outside the repo in the external pdf2w service. The
Node toolchain still carried real operational cost: a native `sqlite3` binding that could lock and
refuse to build, a native `@napi-rs/canvas` image stack, an Electron shell that dynamically
imported `dist/index.js` or fell back to `npx tsx`, and three runtime dependencies
(`pdf-parse`, `pdfjs-dist`, `tesseract.js`) imported nowhere at runtime. The browser dashboard,
however, is DOM code Go cannot render natively, so it had to stay TypeScript.

## Decision

Replace the whole TypeScript backend with **one static, CGO-free Go binary** named `pdf-triage`,
built with `make build` into `dist/pdf-triage`, exposing four subcommands:

```
./dist/pdf-triage serve        # HTTP + SSE dashboard/API + 10 s auto-watcher
./dist/pdf-triage scan         # one-shot triage scan
./dist/pdf-triage mcp          # MCP over stdio (+ streamable HTTP per settings)
./dist/pdf-triage vision-lab   # standalone Vision Lab diagnostic server
```

The composition root is `cmd/pdf-triage`; the binary is built from the existing
`services/pdf-triage-pdf2w` submodule, so the ported domain packages stay where they were. The
layers are `domain` (top-level pure packages) → `infra/` → `store/` → `app/` →
`httpapi` / `mcpserver` / `visionlab` → `cmd/pdf-triage`. Dependencies are the Go standard library
plus `modernc.org/sqlite` (pure Go, over the **same** `pdf_triage.db` schema), `golang.org/x/image`,
`github.com/pdfcpu/pdfcpu`, and `github.com/modelcontextprotocol/go-sdk` v1.3.1.

TypeScript now exists only for the browser dashboard (`public/ts` → `public/js`, `public/scss` →
`public/style.css`), served as static files. Extraction remains the external, self-hosted pdf2w
service (`PDF2W_SERVICE_URL`); canonical-path computation (`canonicalpath`) and text cleaning
(`cleantext`) moved **in-process**, removing two loopback HTTP hops and the helper Docker service
that used to expose them.

### TypeScript path → Go package map

Derived from the `src/` citations in the Go package doc comments.

| Retired TypeScript path | Go package that replaced it |
| --- | --- |
| `src/domain/classification.ts` | `classification` |
| `src/domain/classification-resolution.ts` | `classificationresolution` |
| `src/domain/prompt.ts` | `prompt` |
| `src/domain/prompt-personalization.ts` | `promptpersonalization` |
| `src/domain/taxonomy.ts` | `taxonomy` (and `canonicalpath` for `computeCanonicalPath`) |
| `src/domain/pdf-text.ts` | `pdftext` + `cleantext` |
| `src/domain/pdf-page-fit.ts` | `pdfpagefit` |
| `src/domain/flood-crop.ts` | `floodcrop` |
| `src/domain/image-adjust.ts` | `imageadjust` |
| `src/domain/exif-orientation.ts` | `exiforientation` |
| `src/domain/image-dimensions.ts` | `imagedimensions` |
| `src/domain/markdown-tables.ts` | `markdowntables` |
| `src/domain/taxonomy-conflicts.ts` | `taxonomyconflicts` |
| `src/domain/decision-rule.ts` | `decisionrule` |
| `src/domain/chat-query.ts` | `chatquery` |
| `src/domain/document.schema.ts` | `documentschema` |
| `src/domain/extraction-quality-gate.ts` | `extractionqualitygate` |
| `src/domain/path-conversion.ts` | `pathconv` |
| `src/application/classify-document.ts` | `app/classify` |
| `src/application/triage-scan.ts` | `app/triagescan` |
| `src/application/convert-image-document.ts` | `app/convertimage` |
| `src/application/image-to-pdf.ts` | `app/imagetopdf` |
| `src/application/repair-registry.ts` | `app/repair` |
| `src/application/relocalize-document.ts` | `app/relocalize` |
| `src/application/clear-registry.ts` | `app/clear` |
| `src/application/scan-lock.ts` | `app/scanlock` |
| `src/application/ai-chat-assistant.ts` | `app/aichat` |
| `src/application/chat-query-planner.ts` | `app/chatplanner` |
| `src/infrastructure/http/task-state.ts` | `app/taskstate` |
| `src/infrastructure/http/web-server.ts` | `httpapi` |
| `src/infrastructure/mcp/mcp-server.ts` | `mcpserver` |
| `src/infrastructure/settings.ts` | `infra/settings` |
| `src/infrastructure/os-open.ts` | `infra/osopen` |
| `src/infrastructure/logger.ts` | `infra/logger` |
| `src/infrastructure/ollama-client.ts` | `infra/ollama` |
| `src/infrastructure/pdf2w-remote.ts` | `infra/pdf2w` |
| `src/infrastructure/pdf-extractor.ts` | `infra/pdfextractor` |
| `src/infrastructure/pdf-scanner.ts` | `infra/pdfscanner` |
| `src/infrastructure/pid-lock.ts` | `infra/pidlock` |
| `src/infrastructure/json-registry.ts` | `infra/jsonregistry` |
| `src/infrastructure/zip-builder.ts` | `infra/zipbuilder` |
| `src/infrastructure/image-processor.ts` | `infra/imageprocessor` |
| `src/infrastructure/vision-client.ts` | `infra/vision` |
| `src/infrastructure/orientation-detector.ts` | `infra/orientation` |
| `src/infrastructure/crop-detector.ts` | `infra/crop` |
| `src/infrastructure/categories-store.ts` | `store/categories` |
| `src/infrastructure/entity-dictionary-store.ts` | `store/entitydictionary` |
| `src/infrastructure/prompt-personalization-store.ts` | `store/promptpersonalization` |
| `src/infrastructure/manual-decisions-store.ts` | `store/manualdecisions` |
| `src/infrastructure/taxonomy-hints-store.ts` | `store/taxonomyhints` |
| `src/infrastructure/db/database.ts` | `store/database` |
| `src/infrastructure/canonical-path-remote.ts` | in-process `canonicalpath` (no HTTP) |
| `src/infrastructure/clean-text-remote.ts` | in-process `cleantext` (no HTTP) |
| `src/vision-lab-server.ts` | `visionlab` |
| `src/vision-lab-main.ts` / `src/index.ts` | `cmd/pdf-triage` |
| `scripts/build-exe.mjs` | root `Makefile` |
| `scripts/merge-subcategories.ts`, `desktop/main.cjs` | retired with no replacement |

### Operating rules learned

These caused real confusion during the differential work and are now part of the runbook:

| Rule | Why |
| --- | --- |
| **Never run the binary bare.** `./dist/pdf-triage` with no argument defaults to `serve`, and `BASE_DIR` defaults to the process working directory — so running it from the wrong place serves the wrong tree. Always pass an explicit subcommand, and for checks use `go test`. | A bare invocation starts a long-running server with the repo as its asset root, which is exactly the "wrong BASE_DIR, near-empty data" failure the port-takeover lock work exists to prevent. |
| **Always isolate `BASE_DIR` / `DATA_DIR` / `INPUT_DIR` / `OUTPUT_DIR` / `DB_PATH` and use a non-default `PORT`.** | Tests and experiments must never share the operator's folders, lock files, or port. |
| **Never open the live `pdf_triage.db`.** Copy it first (`cp`), then point the copy at the run. | FTS5 / BM25 smoke tests and differential runs mutate the DB; the live file is the operator's data. |
| **Differential checks skip unless `PDF_TRIAGE_DIFF_DB_GO` and `PDF_TRIAGE_DIFF_TS_FIXTURE` are set.** | `TestDifferentialParity` is opt-in; a plain `go test ./...` never opens a real database. |
| **The operator starts the server, not the agent.** | Same rule as before the cutover: agents run `go test`, never `serve`, `make dev`, or `air`. |

## Alternatives considered

**Rewrite the browser dashboard in Go/WASM.** Rejected: browsers cannot execute Go or native Rust,
a Rust→WASM rewrite had already been declined, and rewriting the UI would multiply scope for no
backend benefit and destroy the parity-behind-the-frozen-contract cutover (46 REST routes + the SSE
event catalogue) that let both backends coexist safely.

**Use Rust instead of Go.** Rejected: no component showed a measured CPU hotspot. Every ported
module is pure logic or I/O glue, and the one genuinely compute-heavy component — extraction — is
already Rust and already lives outside pdf-triage in the pdf2w service. Rust stays a possibility
only behind a measured hotspot and a named integration boundary.

**One microservice per function.** Rejected: the domain functions are hot-path — called per file in
a loop or per DB row (`isForbiddenSubcategory`, `detectFileType`, `cleanExtractedText`,
`computeCanonicalPath`). Turning every call site into a loopback network hop would multiply latency
and failure modes; the two hops that existed were collapsed in-process at cutover instead.

**Use `pdfcpu`'s `ImportImages` to assemble photo pages.** Rejected: the photo pipeline's page
geometry (`pdfpagefit`) is pure and already validated pixel-for-pixel; `ImportImages` would
replace it with pdfcpu's own fit rules and change the assembled page semantics. `pdfcpu` is used
only for assemble / merge / split of existing PDFs.

## Consequences

**Bought.** A single static binary removes the native-binding failure mode, collapses the process
model to one executable, and makes port takeover and single-instance locking ordinary OS
operations. The backend no longer needs Node, tsx, Vitest, Electron or the npm dependency tree;
`go build ./...` / `go test ./...` is the single gate. Removing the two loopback hops is strictly
faster and removes two Docker processes from the runtime.

**Given up.** The **Electron desktop shell** is gone for now — launching is "run the binary and open
the browser", with the tray/Wails/installer decision deferred to the operator. The **two HTTP hops**
(`computeCanonicalPath`, `cleanExtractedText`) are gone as separate services, which removes the
network boundary that made them independently deployable. **Per-request schema validation bodies**
are gone: the Go server answers malformed input as plain `{ error: <string> }` instead of the
pretty-printed Zod issue array (some statuses differ; see the HTTP parity audit). The **TypeScript
prompt-hygiene test was retired**: it scanned the repo tree against `CONFIG.PERSONAL_NAME_DENYLIST`
and was red upstream; a repo-tree personal-data scan belongs in CI and is an **open item**.

**Not covered.** The desktop shell, Windows installer tooling, the repository rename of the Go
submodule (a module-path rewrite), the parity gaps G1–G7 from the HTTP audit, and the CI
personal-data scan are all deferred. Nothing enforces this note's map either — it is kept current
by hand.
