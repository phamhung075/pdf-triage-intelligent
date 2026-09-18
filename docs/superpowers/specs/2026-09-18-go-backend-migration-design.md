# Design: Migrate the pdf-triage backend to one Go binary

> Status: design approved by the orchestrator; decisions recorded here are settled and are not
> re-opened by this document. This is the umbrella spec for the full-backend Go migration whose
> first slice shipped as the pdf2w extraction swap
> ([2026-09-17-pdf2w-extraction-swap-design.md](2026-09-17-pdf2w-extraction-swap-design.md)).
>
> All statements about current behavior below are cited from the read-only evidence inventory
> [`scratch/go-backend-inventory.md`](../../../scratch/go-backend-inventory.md) ("inv"), which
> carries the `file:line` evidence. This spec does not re-derive that evidence.

## Scope

**In scope:**

1. Replacing every TypeScript backend module under `src/` (8,288 non-test lines across 35
   application + infrastructure modules, inv §1–§2), the `scripts/` tools (inv §7), and the
   Electron shell `desktop/main.cjs` (inv §7, 303 lines) with one Go binary named `pdf-triage`
   exposing `serve | scan | mcp | vision-lab`.
2. Removing the Electron / electron-builder / tsx / vitest / npm-dependency toolchain from the
   backend build (inv §6, §7), while keeping the browser dashboard in TypeScript/JS/HTML.
3. Preserving the existing HTTP/SSE contract (46 REST routes, inv §3) and MCP tool contract
   (9 tools, inv §4) exactly.
4. Preserving the existing SQLite schema, FTS5 index and `settings.json` / taxonomy / JSON-registry
   files with no data migration (inv §5, inv §2.1–§2.2).

**Explicitly out of scope:** rewriting the browser dashboard; changing the SQLite schema; changing
the classification prompt semantics or the pdf2w extraction boundary; introducing Rust; a repo
rename; a Windows installer tool decision. Later sections state each of these as a non-goal or a
deferred owner decision.

## Why

- The backend is pure logic and I/O glue. Every application module is asynchronous orchestration
  over filesystem / HTTP / SQLite, and the only pure functions are text and geometry helpers
  (inv §1); the infrastructure layer is adapters (inv §2). Nothing needs the Node runtime, and
  the one genuinely CPU-heavy engine that does — extraction — already lives outside pdf-triage in
  the external pdf2w service (inv §2.5, `pdf2w-remote.ts:19`).
- The current toolchain carries avoidable operational cost: a native `sqlite3` binding that can
  lock and refuses to build (inv §7, `scripts/build-exe.mjs:48`–`:79`), a native
  `@napi-rs/canvas` image stack (inv §6, inv §9.1), an Electron shell that dynamically imports
  `dist/index.js` or falls back to `npx tsx` (inv §7, `desktop/main.cjs:77`–`:105`), and three
  currently-unused runtime dependencies (`pdf-parse`, `pdfjs-dist`, `tesseract.js`) that are
  imported nowhere at runtime (inv §6).
- A single static binary removes the native-binding failure mode, collapses the process model to
  one executable, and makes port takeover and single-instance locking ordinary OS operations
  (inv §3.3).
- The migration frontier is already Go: 18 pure-Go domain packages exist in the submodule with
  zero external dependencies (inv §8), and `computeCanonicalPath` / `cleanExtractedText` are
  already reachable as Go over HTTP (inv §2.5).

## Target architecture

```
pdf-triage (single Go binary)
├── cmd/pdf-triage          composition root: serve | scan | mcp | vision-lab  (replaces src/index.ts,
│                           src/vision-lab-main.ts, desktop/main.cjs)
├── httpapi                 net/http REST + SSE server, static public/         (replaces
│                           http/web-server.ts, vision-lab-server.ts)
├── mcpserver               MCP stdio + streamable HTTP                        (replaces mcp/mcp-server.ts)
├── app/<name>              orchestration / use-cases                          (replaces src/application/*)
├── store/<name>            SQLite + file stores                               (replaces db/, *-store.ts,
│                           json-registry.ts, manual-decisions-store.ts)
├── infra/<name>            I/O adapters: ollama, pdf2w, canonicalpath client,
│                           image decode/encode, process launch, logging       (replaces
│                           src/infrastructure/* non-store modules)
└── existing top-level domain packages (classification, classification-resolution, prompt,
    taxonomy, pdftext, markdowntables, extractionqualitygate, pdfpagefit, floodcrop, imageadjust,
    exiforientation, imagedimensions, chatquery, decisionrule, cleantext, pathconv, canonicalpath,
    documentschema, promptpersonalization, taxonomyconflicts)

browser dashboard: public/ts -> public/js, public/scss -> public/style.css   (UNCHANGED, static)
external: pdf2w markdown-extract-service (extraction), Ollama                     (UNCHANGED)
```

The existing top-level domain packages stay exactly where they are in
`services/pdf-triage-pdf2w/`; the new `infra/`, `store/`, `app/`, `httpapi/`, `mcpserver/`, and
`cmd/pdf-triage` layers are added to that same module. The two Go services already wired over HTTP
(`canonicalpath`, `cleantext`, inv §8, `cmd/server/main.go:13`–`:15`) are imported in-process at
cutover instead.

### Frozen contract

The browser dashboard is served as static files by the Go server and is not rewritten. Its
REST/SSE contract is therefore frozen for the whole migration: all **46 REST routes** in
inventory §3 (methods, paths, request/response shapes, status codes such as the 409
scan-in-progress guards at inv §3 rows 9 and 43), and every SSE event type in inventory §3.1:
`TASK_STARTED`, `TASK_PROGRESS`, `TASK_FINISHED`, `TASK_FAILED`, `SCAN_STARTED`, `FILE_PROGRESS`,
`FILE_COMPLETED`, `FILE_FAILED`, `SCAN_COMPLETED`, `OLLAMA_DOWN`, `REPAIR_STARTED`,
`REPAIR_COMPLETED`, `CLEAR_STARTED`, `CATEGORIES_UPDATED`, `REGISTRY_UPDATED`,
`DECISIONS_UPDATED`, `DOCUMENTS_UPDATED`, the log stream's `INIT` and `LOG`, and the live-reload
raw `data: reload`. The MCP surface (9 tools, stdio + streamable HTTP, bearer-token auth) in
inventory §4 is frozen the same way.

## Decisions

### 1. End state: one Go binary with four subcommands

End state is one binary, `pdf-triage`, with subcommands `serve` (HTTP + SSE + auto-watcher),
`scan` (one-shot), `mcp` (MCP stdio / streamable HTTP), and `vision-lab` (standalone diagnostic
server), replacing every TypeScript module under `src/`, the `scripts/` tools, `desktop/main.cjs`,
and the Electron / electron-builder / tsx / vitest toolchain (inv §1–§2, §6–§7). The browser
dashboard (`public/ts` → `public/js`, SCSS → CSS) stays TypeScript/JS/HTML and is served as static
files unchanged by the Go server, so its REST/SSE contract over all 46 routes and every SSE event
type (inv §3, §3.1) is frozen.

**Rationale:** the backend's Node-specific value is the runtime, not the language; the dashboard's
value is the browser DOM, which Go cannot render natively. Freezing the contract lets the Go
backend be built to parity behind the existing UI while TypeScript keeps running, so no UI
regression is coupled to the port.

**Rejected alternative:** rewriting the UI in Go. Browsers cannot execute Go or native Rust, and a
Rust→WASM UI rewrite was already declined by the owner. Rewriting the UI would multiply scope for
no backend benefit and break the parity-behind-the-contract cutover.

### 2. Repo and module layout

The whole backend lives in the existing repo `github.com/phamhung075/pdf-triage-pdf2w`, checked out
as the submodule `services/pdf-triage-pdf2w` (inv §8, `go.mod:1`–`:3`). Existing top-level domain
packages stay where they are, so the port adds no import churn to the 18 already-ported packages
(inv §8). New layers are `infra/<name>` (I/O adapters), `store/<name>` (SQLite + file stores),
`app/<name>` (orchestration), `httpapi`, `mcpserver`, and `cmd/pdf-triage`. The repo name is now a
misnomer; renaming it is recorded as a deferred, owner-decision item because it forces a module
path rewrite.

**Rationale:** the domain packages are the migration's foundation and are already tested; keeping
them in place means the new layers import them rather than being restructured around them. Adding
layers in the same module keeps `go build ./...` and `go test ./...` as the single gate.

**Rejected alternative:** a new repo or a new module path now. It would break every existing
import and the pinned submodule commit for zero functional gain while the port is in flight; the
rename is cheaper once the backend is Go-only.

### 3. Dependencies: stdlib first, four approved additions, three drops

Standard library first. Approved external dependencies, all pure Go with no cgo:

| Dependency | Replaces | Evidence |
| --- | --- | --- |
| `modernc.org/sqlite` via `database/sql` | `sqlite` + native `sqlite3` | inv §6; FTS5 + `bm25` must be smoke-tested against a **copy** of the real `pdf_triage.db` in `scratch/`, never the live file (inv §9.2) |
| `github.com/modelcontextprotocol/go-sdk` | `@modelcontextprotocol/sdk` | inv §6, §4; stdio + streamable HTTP |
| `github.com/pdfcpu/pdfcpu` | `pdf-lib` (assemble / merge / split) | inv §6; `convert-image-document.ts:4`, `web-server.ts:25`, `:896`, `:1041` |
| `golang.org/x/image` | `@napi-rs/canvas` webp/bmp/tiff/draw decode/encode | inv §6, §9.1 |

Drop, do not port: `pdf-parse`, `pdfjs-dist`, `tesseract.js` — none is imported at runtime
(inv §6, `pdf-parse` appears only in a comment at `domain/pdf-text.ts:7`; OCR is delegated to
pdf2w, `pdf-extractor.ts:37`–`:43`). Each dependency addition needs its `go.mod` line justified in
the PR that adds it; `go.mod` stays dependency-free until the phase that actually needs it.

**Rationale:** stdlib `net/http`, `image/jpeg`, `image/png`, `image/draw`, `encoding/json`, `os`,
and `sync` cover the routing, HTTP clients, JSON, file I/O, and locking surfaces (inv §6). The four
additions are unavoidable and all avoid cgo, which is what makes a static binary and removes the
native-binding lock (inv §7, `scripts/build-exe.mjs:48`–`:79`). `modernc.org/sqlite` must be
validated against the real schema before it is trusted (inv §9.2).

**Rejected alternative:** `mattn/go-sqlite3` (requires cgo, reintroduces a build toolchain and the
binary-linking failure mode) and `github.com/bep/godartsass` for SCSS (cgo; SCSS stays a
build-time tool). Hand-rolling PDF assembly or the MCP protocol was rejected as
correctness-sensitive reimplementation of solved formats.

### 4. Rust posture

No component has so far shown a technical reason for Rust. Every module being ported is pure logic
or I/O glue (inv §1–§2), and the one genuinely compute-heavy component — the extraction engine —
is already Rust and already lives outside pdf-triage in the external pdf2w service
(inv §2.5; 2026-09-17 spec's target architecture). The criterion for introducing Rust later is a
**measured CPU hotspot**, not a preference. The concrete candidate is the image
decode/crop/enhance path (inv §9.1, `image-processor.ts:22`–`:218`) if the Go port proves too slow
or not pixel-faithful; integration would be a subprocess or a cgo-free boundary.

**Rationale:** Rust for its own sake adds a second toolchain and a second failure surface to a
codebase whose remaining problems are correctness and parity, not CPU. A measured hotspot plus a
named integration boundary is a testable trigger; "the project is moving to Go/Rust" is not.

**Rejected alternative:** pre-emptively porting image adjustment or crop detection to Rust, or
building a Rust FFI boundary before a benchmark demands one. Both contradict the stdlib-first,
parity-first posture and the existing evidence that the ported logic is not CPU-bound.

### 5. Cutover: parity behind the frozen contract, then one switch

The Go backend is built to parity behind the frozen contract while the TypeScript backend keeps
running. Cutover is a single switch: the user runs the Go binary instead of `npm run dev`,
followed by deleting `src/`, `scripts/`, `desktop/main.cjs`, the backend `tsconfig.json`, and the
Electron dependencies. Until cutover, per-port TypeScript wiring is **not** done (owner
instruction); the two ports already wired — `computeCanonicalPath` and `cleanExtractedText`, called
over HTTP from TypeScript (`canonical-path-remote.ts:9`, `clean-text-remote.ts:9`, inv §2.5) — are
removed at cutover when those calls become in-process. The Go binary opens the EXISTING
`pdf_triage.db` and the existing `settings.json` / taxonomy / JSON files unchanged, with no data
migration and a schema-compatible read/write path (inv §5), so cutover is reversible by reverting
to the TypeScript backend and its unchanged files.

**Rationale:** building both implementations against one frozen contract is what makes a single
switch safe and keeps rollback cheap. Avoiding per-port TS wiring prevents throwaway integration
work on modules that are about to be deleted. In-process calls at cutover are strictly faster than
the HTTP hop they replace, so removing them is a simplification, not a regression.

**Rejected alternative:** a gradual, route-by-route cutover with the two backends sharing traffic.
It needs a proxy layer, doubles the running surface, and would require exactly the per-port
TypeScript wiring the owner excluded.

### 6. Golden-rule guards: one shared `app/guards` package

The three surfaces where the Golden-Rule write guards currently live — `web-server.ts` (`:586`,
`:1262`, `:1277`), `mcp-server.ts` (`:236`, `:264`), and `triage-scan.ts` (`:301`, `:382`) (inv
§9.3) — get ONE shared Go package, `app/guards`, implementing forbidden-subcategory rejection,
pre-move category/subcategory auto-creation, path-boundary confinement, and checksum dedup. Every
existing call site's test is ported, and no call site may reimplement a guard.

**Rationale:** the guards encode Golden Rules 3, 4, 5, and 20 (no-text block; forbidden
subcategory; `.categories.private.json` pre-move auto-create; path boundary; SHA-256 dedup). They
are duplicated across three surfaces today, and inv §9.3 identifies divergent centralisation as a
route to silently archiving into banned taxonomy branches. One package with ported call-site tests
makes the rule set reviewable in one place.

**Rejected alternative:** porting each guard inline at each call site, or splitting them per
surface. Both preserve today's duplication and the exact failure mode inv §9.3 warns about.

### 7. Locking and concurrent-scan serialization

The three current locks get explicit Go equivalents: the server single-instance lock
`DATA_DIR/.server.lock` (inv §3.3, `web-server.ts:1541`–`:1556`), the cross-process scan lock
`.scan.lock` (inv §1.10, `scan-lock.ts:15`, `:35`), and the in-memory auto-watcher/abort flags
`isAutoScanning` / `manualStopCooldownUntil` / `scanAbortRequested` (inv §3, `web-server.ts:84`,
`:86`, `:1397`; inv §3.2, `:1422`–`:1477`). The ordering that prevents the concurrent-scan
`UNIQUE constraint failed: documents.checksum` failure documented at `triage-scan.ts:373`–`:384`
is restated and preserved: the auto-watcher claims the in-memory guard synchronously before any
`await` (`web-server.ts:1434`), and the scan path holds the cross-process scan lock for the whole
run so two scans can never both insert a new checksum. Windows port takeover via `netstat -ano -p
tcp` + `taskkill /PID /F` (inv §2.1, `pid-lock.ts:41`–`:71`; inv §3.3, `:1585`–`:1593`) lives
behind a build-tagged file; Linux/WSL uses the same lock semantics with POSIX process checks.

**Rationale:** locks are where a port most easily changes observable behavior. Making the Go
equivalents and the lock ordering explicit turns the checksum-UNIQUE race from a subtle
concurrency assumption into a documented invariant, and `pid-lock.ts` is already OS-branching
(inv §2.1), so a build-tagged file is the natural Go form.

**Rejected alternative:** replacing the file locks with a purely in-process mutex (breaks the
cross-process `.scan.lock` behavior between `serve` and `scan`) or porting `netstat`/`taskkill`
into shared cross-platform code (breaks on Linux/WSL).

### 8. Ollama client contract preserved exactly

The Go Ollama client preserves, exactly: `format: "json"`, `think: false`, `num_ctx: 16384`,
`num_predict: 4096`, the `done_reason == "length"` truncation check, and the distinction between
"Ollama down" (connection failure, surfaced as `OllamaUnavailableError` / `OLLAMA_DOWN`) and
"bad JSON" from a reachable model. Evidence: `ollama-client.ts:20` (down-pattern classifier),
`:103`–`:124` (request options), `:138`–`:154` (`doneReason`), `classify-document.ts:175` (length
check); inv §9.4.

**Rationale:** these values are load-bearing, not tuning defaults. `format json` and the truncation
check decide whether a classification can be parsed at all; the down-vs-bad-JSON split decides
whether a failed file is retried or blocked (inv §9.4). A hand-rolled client that "improves" any of
them changes runtime behavior the tests and the UI depend on.

**Rejected alternative:** using the official `github.com/ollama/ollama/api` client and accepting
its defaults. It would still require overriding every one of these options, and it adds a
dependency whose transport behavior (retries, error shape) would need the same explicit pinning.

### 9. Testing: case-for-case port, httptest, golden-file contract replay

Every TypeScript test file for a ported module is ported case-for-case — the same acceptance bar
used for the 18 already-ported domain packages (inv §8). HTTP tests use `net/http/httptest`. A
golden-file contract test replays representative REST/SSE exchanges against both backends where
feasible. The pre-existing red TypeScript tests are **not** ported as-is; for each the Go port pins
actual behavior and records the contradiction:

- `markdown-tables` `restoreMissingTableHeaderCells` — the fixture contradicts its own title.
- `prompt-hygiene` denylist.
- Two `web-server` tests.

**Rationale:** case-for-case porting is the only acceptance bar that has already worked on this
codebase (inv §8). `httptest` exercises the frozen contract without a live port, and a golden-file
replay against both backends is the one test that can prove parity of the 46 routes and the SSE
streams (inv §3) rather than asserting it. Carrying a red test forward either freezes a bug as
expected behavior or blocks the port; pinning actual behavior records the contradiction without
silently "fixing" it.

**Rejected alternative:** porting the red tests unchanged (would either fail forever or force a
behavior change outside this migration's scope), or dropping them silently (loses the record of
the contradiction).

### 10. Porting phases

Reproduced from inventory §8 (phases 0–9). Phase 0 (domain completion: `classification`,
`classification-resolution`, `prompt`) is in progress; Phase 1 (`zipbuilder`, `jsonregistry`,
`pdfscanner`, `pidlock`, `logger`, `taskstate` — stdlib only) is dispatched.

| Phase | Deliverable | New Go packages | Consumed existing packages | Exit criterion | Top risk |
| --- | --- | --- | --- | --- | --- |
| 0 | Domain completion: classification, resolution, prompt | `classification`, `classificationresolution`, `prompt` | `documentschema`, `taxonomy`, `taxonomyconflicts`, `promptpersonalization`, `decisionrule`, `markdowntables`, `pdftext` | `go test` green; ported cases reproduce `classification.ts` (724), `classification-resolution.ts` (265), `prompt.ts` (174) (inv §8) | Semantic parsing drift in `ruleBasedClassify` / `cleanAndParseJSON` (inv §1.1) |
| 1 | Leaf infra: zip, JSON mirror, scanner, locks, logging, task state | `zipbuilder`, `jsonregistry`, `pdfscanner`, `pidlock`, `logger`, `taskstate` | `taxonomy` (`isPathInsideDir`) | `go test` green; atomic-rename + EPERM/EBUSY fallback reproduced (`json-registry.ts:23`–`:60`) | Windows `netstat`/`taskkill` port takeover in `pidlock` (inv §2.1, §9.5) |
| 2 | Settings / config / data dirs | `settings` | `pathconv` | `go test` green; `CONFIG`, `BASE_DIR`, `PDF_TRIAGE_BASE_DIR`, `DATA_DIR` parity (`settings.ts:15`–`:208`) | WSL path normalization on config load (Golden Rule 21) |
| 3 | SQLite: schema, migrations, FTS5, BM25 | `store/database` | `taxonomy` (`detectFileType`) | `go test` green; FTS5 + `bm25` smoke test against a COPY of `pdf_triage.db` (inv §9.2) | `modernc.org/sqlite` FTS5 availability and exact `bm25` weights (`database.ts:493`–`:553`) (inv §9.2) |
| 4 | Taxonomy / prompt / decision stores | `store/categories`, `store/entitydictionary`, `store/promptpersonalization`, `store/manualdecisions`, `store/taxonomyhints` | `documentschema`, `taxonomy`, `taxonomyconflicts`, `promptpersonalization`, `decisionrule` | `go test` green; private-overlay diff writes reproduced (`categories-store.ts:92`–`:110`) | Writing public vs private taxonomy (`categories-store.ts`, Golden Rule 5) |
| 5 | Remote adapters: pdf2w, clean-text, canonical-path, extractor, Ollama | `infra/pdf2w`, `infra/cleantext` (in-process), `infra/canonicalpath` (in-process), `infra/pdfextractor`, `infra/ollama` | `cleantext`, `canonicalpath`, `pdftext` | `go test` green; Ollama contract §8 asserted byte-for-byte on the request body | Down-vs-bad-JSON distinction and `done_reason` check (inv §9.4) |
| 6 | Image / vision adapters | `infra/imageprocessor`, `infra/vision`, `infra/orientation`, `infra/crop` | `floodcrop`, `imageadjust`, `exiforientation`, `imagedimensions`, `pdfpagefit` | `go test` green; pixel-semantics parity on decode/encode seam | Native image-stack replacement; EXIF/crop invariants (inv §9.1, Golden Rule 17) |
| 7 | Application orchestration | `app/imagetopdf`, `app/convertimage`, `app/relocalize`, `app/classify`, `app/chatplanner`, `app/aichat`, `app/triagescan`, `app/repair`, `app/clear`, `app/scanlock`, `app/guards` | phases 0–6; `pdfpagefit`, `extractionqualitygate`, `markdowntables`, `chatquery`, `taxonomy`, `taxonomyconflicts` | `go test` green; sequential per-file scan with 50 ms yield reproduced (Golden Rule 9) | Guards centralisation and the checksum-UNIQUE scan race (inv §9.3, §9.5) |
| 8 | HTTP REST/SSE + MCP + Vision Lab servers | `httpapi`, `mcpserver`, `cmd/visionlab` | phase 7 + MCP SDK; `canonicalpath`, `cleantext` | `go test` green; golden-file replay of 46 routes + SSE events vs TS backend | Frozen-contract parity across all routes and event types (inv §3) |
| 9 | Composition root and desktop replacement | `cmd/pdf-triage` | everything above | `go test` green; `serve`/`scan`/`mcp`/`vision-lab` subcommands behave as `npm` scripts did | Desktop shell replacement (tray vs Wails vs open-browser) is an owner decision (§11) |

### 11. Non-goals and open questions for the owner

- **Repo rename** of `github.com/phamhung075/pdf-triage-pdf2w`: deferred; cost is a module-path
  rewrite across the whole repo (inv §8).
- **Desktop shell:** tray binary (`github.com/getlantern/systray`), Wails webview, or plain
  `open browser` — undecided (inv §6, §7).
- **Windows installer tooling:** goreleaser + NSIS versus another packaging path — undecided
  (inv §6, §7, `package.json:71`–`:104`).

## Risks / accepted trade-offs

- **Native image-stack replacement** (inv §9.1): the decode/encode seam must reproduce exact
  pixel/EXIF semantics or Golden Rule 17's photo invariants break.
- **SQLite + FTS5 parity** (inv §9.2): validated only by a smoke test against a copy of the real
  `pdf_triage.db`, never the live file.
- **Guard centralisation** (inv §9.3): one `app/guards` package is only safe if every call site's
  test is ported.
- **Ollama contract drift** (inv §9.4): pinned in §8 and asserted in Phase 5.
- **Locking and concurrency** (inv §9.5): the checksum-UNIQUE race is the failure mode the lock
  ordering in §7 exists to prevent.
- **Migration duration:** two backends coexist until cutover; each new module must be built to
  parity without per-port TypeScript wiring.
