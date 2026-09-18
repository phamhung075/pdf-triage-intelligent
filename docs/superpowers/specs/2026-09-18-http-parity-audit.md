# HTTP-layer parity audit — Go `httpapi` vs TypeScript `web-server.ts`

Read-only. Evidence is `file:line`. Sources: TS `src/infrastructure/http/web-server.ts` (1,595 lines),
Go `services/pdf-triage-pdf2w/httpapi/*.go`, inventory `docs/superpowers/specs/2026-09-18-go-backend-inventory.md` §3.
Test run (this session, background, exit 0):
`npx vitest run src/infrastructure/http/web-server.test.ts src/infrastructure/http/task-state.test.ts --reporter=verbose`
→ `Test Files 1 failed | 1 passed (2)`, `Tests 2 failed | 54 passed (56)` (53 web-server + 3 task-state).
No server was started; no file other than this one was written.

Conventions: reg = `mux.HandleFunc` registration; handler = implementing function. Every route
resolves through `http.NewServeMux` in `httpapi/server.go:272`, built-in groups `:274-283`, mutation
group `documents_write.go:220`, read/export group `documents_read.go:114`.

---

## 1. ROUTE TABLE (46/46 registered, 0 missing)

All 46 rows of inventory §3 are registered. Grep of `app.(get|post|put|delete)` in
`web-server.ts` returns exactly 46 registrations (`web-server.ts:90`–`:1482`), i.e. **no TS route
exists that is missing from the inventory table** (the only other mount is
`express.static(publicDir)` at `web-server.ts:77`, not a REST route).

| # | Method | Path | TS reg | Go reg (file:line) | Go handler |
|---|--------|------|--------|--------------------|------------|
| 1 | GET | /api/dev/livereload | web-server.ts:90 | httpapi/livereload.go:24 | liveReloadHandler |
| 2 | POST | /api/open-location | web-server.ts:118 | httpapi/open.go:21 | openLocationHandler |
| 3 | POST | /api/open-chrome | web-server.ts:148 | httpapi/open.go:25 | openChromeHandler |
| 4 | GET | /api/ollama/status | web-server.ts:184 | httpapi/ollama.go:18 | ollamaStatusHandler |
| 5 | GET | /api/ollama/models | web-server.ts:213 | httpapi/ollama.go:19 | ollamaModelsHandler |
| 6 | POST | /api/ollama/start | web-server.ts:226 | httpapi/ollama.go:20 | ollamaStartHandler |
| 7 | POST | /api/server/restart | web-server.ts:240 | httpapi/system.go:19 | serverRestartHandler |
| 8 | GET | /api/triage/status | web-server.ts:250 | httpapi/system.go:20 | triageStatusHandler |
| 9 | POST | /api/registry/repair | web-server.ts:255 | httpapi/documents_write.go:227 | registryRepairHandler |
| 10 | GET | /api/config/setup-state | web-server.ts:288 | httpapi/system.go:21 | setupStateHandler |
| 11 | GET | /api/config | web-server.ts:314 | httpapi/system.go:22 | getConfigHandler |
| 12 | GET | /api/system/stats | web-server.ts:330 | httpapi/system.go:23 | systemStatsHandler |
| 13 | PUT | /api/config | web-server.ts:422 | httpapi/system.go:24 | putConfigHandler |
| 14 | GET | /api/logs/recent | web-server.ts:443 | httpapi/logs.go:17 | logsRecentHandler |
| 15 | GET | /api/logs/sessions | web-server.ts:454 | httpapi/logs.go:18 | logsSessionsHandler |
| 16 | GET | /api/logs/stream | web-server.ts:464 | httpapi/logs.go:19 | logsStreamHandler |
| 17 | GET | /api/categories | web-server.ts:489 | httpapi/categories.go:21 | getCategoriesHandler |
| 18 | GET | /api/blocked-files | web-server.ts:535 | httpapi/blocked.go:13 | blockedFilesHandler |
| 19 | GET | /api/manual-decisions | web-server.ts:545 | httpapi/decisions.go:27 | listManualDecisionsHandler |
| 20 | PUT | /api/manual-decisions/:id | web-server.ts:558 | httpapi/decisions.go:28 | updateManualDecisionHandler |
| 21 | DELETE | /api/manual-decisions/:id | web-server.ts:606 | httpapi/decisions.go:29 | deleteManualDecisionHandler |
| 22 | DELETE | /api/manual-decisions | web-server.ts:624 | httpapi/decisions.go:30 | clearManualDecisionsHandler |
| 23 | PUT | /api/categories | web-server.ts:635 | httpapi/categories.go:22 | putCategoriesHandler |
| 24 | POST | /api/subcategories/rename | web-server.ts:650 | httpapi/documents_write.go:230 | renameSubcategoryHandler |
| 25 | GET | /api/documents | web-server.ts:703 | httpapi/documents_read.go:118 | listDocuments |
| 26 | GET | /api/documents/export/csv | web-server.ts:766 | httpapi/documents_read.go:120 | exportCSV |
| 27 | POST | /api/images/import | web-server.ts:844 | httpapi/documents_write.go:233 | importImageHandler |
| 28 | POST | /api/pdf/merge | web-server.ts:889 | httpapi/documents_write.go:236 | mergePDFHandler |
| 29 | POST | /api/chat | web-server.ts:929 | httpapi/documents_write.go:242 | chatHandler |
| 30 | GET | /api/mcp/status | web-server.ts:944 | httpapi/documents_read.go:122 | mcpStatus |
| 31 | POST | /api/documents/package-zip | web-server.ts:960 | httpapi/documents_read.go:124 | packageZip |
| 32 | POST | /api/documents/:id/open-folder | web-server.ts:1001 | httpapi/documents_read.go:126 | openFolder |
| 33 | POST | /api/pdf/split | web-server.ts:1029 | httpapi/documents_write.go:239 | splitPDFHandler |
| 34 | GET | /api/documents/:id/source-image | web-server.ts:1080 | httpapi/documents_read.go:128 | sourceImage |
| 35 | GET | /api/documents/file-by-path | web-server.ts:1112 | httpapi/documents_read.go:130 | fileByPath |
| 36 | GET | /api/documents/:id | web-server.ts:1141 | httpapi/documents_read.go:132 | getDocument |
| 37 | GET | /api/documents/:id/file | web-server.ts:1159 | httpapi/documents_read.go:134 | documentFile |
| 38 | GET | /api/documents/export/markdown | web-server.ts:1185 | httpapi/documents_read.go:138 | exportMarkdown |
| 39 | GET | /api/documents/:id/markdown | web-server.ts:1216 | httpapi/documents_read.go:140 | documentMarkdown |
| 40 | DELETE | /api/documents/:id | web-server.ts:1236 | httpapi/documents_write.go:245 | deleteDocumentHandler |
| 41 | PUT | /api/documents/:id | web-server.ts:1251 | httpapi/documents_write.go:248 | putDocumentHandler |
| 42 | POST | /api/documents/:id/relocalize | web-server.ts:1329 | httpapi/documents_write.go:251 | relocalizeDocumentHandler |
| 43 | DELETE | /api/documents | web-server.ts:1346 | httpapi/documents_write.go:254 | clearDocumentsHandler |
| 44 | GET | /api/triage/events | web-server.ts:1379 | httpapi/triage.go:17 | triageEventsHandler |
| 45 | POST | /api/triage/unlock | web-server.ts:1409 | httpapi/triage.go:18 | triageUnlockHandler |
| 46 | POST | /api/triage/scan | web-server.ts:1482 | httpapi/documents_write.go:257 | triageScanHandler |

**Counts: 46 covered, 0 MISSING, 0 extra TS routes.** Path-wildcard translation is mechanical:
`:id` → `{id}` (Go 1.22 patterns); the TS registration-order dependency
(`/api/documents/export/*` before `/:id`, `web-server.ts:1181-1184`) is handled by ServeMux
specificity, proven by `documents_read_test.go:374`.

---

## 2. TEST PARITY (upstream 53 + 3)

Covered = a Go test asserts the same status/body/headers/side effect. Two upstream cases are RED
(see §4) and are pinned at the actual TS behavior.

### 2a. web-server.test.ts (53 cases)

| # | Upstream case (describe > it) | Go test (file: func/subtest) | Verdict |
|---|-------------------------------|------------------------------|---------|
| 1 | CORS > does not send wide-open ACAO | routes_test.go:84 TestNoCORSHeader; golden_test.go:319 TestGoldenCORS | covered |
| 2 | GET /api/documents > formatted, truncated list | documents_read_test.go:135 TestListDocuments/"returns the formatted, truncated document list" | covered |
| 3 | GET /api/documents > category+subcategory filter | documents_read_test.go:179 TestListDocuments/"filters by category and subcategory query params, case-insensitively" | covered |
| 4 | GET /api/documents > free-text q filter | documents_read_test.go:206 TestListDocuments/"filters by the free-text search query..." | covered |
| 5 | GET /api/documents > 500 on DB throw | documents_read_test.go:227 TestListDocuments/"returns 500 with the error message when the DB layer throws" | covered |
| 6 | GET /:id > full document, tags parsed | documents_read_test.go:240 TestGetDocumentByID/"returns the full document with tags parsed" | covered |
| 7 | GET /:id > 404 | documents_read_test.go:255 TestGetDocumentByID/"returns 404 when the document does not exist" | covered |
| 8 | GET /:id/markdown > sanitized .md download | documents_read_test.go:266 TestDocumentMarkdown/"downloads markdown_content as a .md with a sanitized filename" | covered |
| 9 | GET /:id/markdown > RFC-6266 accent | documents_read_test.go:286 TestDocumentMarkdown/"RFC-6266-encodes an accented title..." | covered |
| 10 | GET /:id/markdown > raw_text fallback | documents_read_test.go:302 TestDocumentMarkdown/"falls back to raw_text when markdown_content is empty" | covered |
| 11 | GET /:id/markdown > 404 | documents_read_test.go:313 TestDocumentMarkdown/"returns 404 when the document does not exist" | covered |
| 12 | GET export/markdown > ZIP bundle | documents_read_test.go:325 TestExportMarkdown/"bundles every document's markdown into one ZIP..." | covered |
| 13 | GET export/markdown > dedupe names | documents_read_test.go:352 TestExportMarkdown/"dedupes filenames ... by suffixing the doc id" | covered |
| 14 | PUT /:id > updates metadata + registry | documents_write_docs_test.go:26 TestPutDocumentRoute/"updates metadata, syncs the registry and returns parsed tags" | covered |
| 15 | PUT /:id > no relocalize when no new_path | — | **UNCOVERED** |
| 16 | PUT /:id > reject forbidden subcategory | documents_write_docs_test.go:48 TestPutDocumentRoute/"rejects an explicit forbidden subcategory before writing" | covered |
| 17 | PUT /:id > reject year-string alias | documents_write_docs_test.go:60 TestPutDocumentRoute/"rejects a year-string subcategorie alias" | covered |
| 18 | PUT /:id > 404 | documents_write_docs_test.go:69 TestPutDocumentRoute/"404 when the document does not exist" | covered |
| 19 | SSE mutation > PUT broadcasts REGISTRY_UPDATED/EDIT | — | **UNCOVERED** |
| 20 | DELETE /api/documents > clear + broadcast | documents_write_test.go:135 TestClearDocumentsRoute/"success broadcasts REGISTRY_UPDATED + CATEGORIES_UPDATED" | covered |
| 21 | DELETE /api/documents > 409 concurrent | documents_write_test.go:124 TestClearDocumentsRoute/"409 while a scan is already in progress" | covered |
| 22 | DELETE /api/documents > 500 + guard release | documents_write_test.go:176 TestClearDocumentsRoute/"500 on failure and lock/guard release" | covered |
| 23 | POST /api/triage/scan > runs + result | documents_write_test.go:197 TestTriageScanRoute/"runs a scan and returns its result" | covered |
| 24 | POST /api/triage/scan > 409 already running | documents_write_test.go:229 TestTriageScanRoute/"409 when already scanning" | covered |
| 25 | GET /api/categories > merges counts | routes_test.go:94 TestGetCategories/"merges DB-derived counts and injects DB-only subcategories" | covered |
| 26 | GET /api/categories > excludes general/year | routes_test.go:133 TestGetCategories/"excludes general and bare year strings from injected subcategories" | covered |
| 27 | blocked-files > total + list | routes_test.go:176 TestGetBlockedFiles/"returns the total count and list" | covered |
| 28 | blocked-files > empty list | routes_test.go:188 TestGetBlockedFiles/"returns an empty list when nothing is blocked" | covered |
| 29 | blocked-files > 500 | routes_test.go:199 TestGetBlockedFiles/"returns 500 when the DB layer throws" | covered |
| 30 | manual-decisions > list total | routes_test.go:211 TestManualDecisions/"lists the recorded decisions with a total" | covered |
| 31 | PUT /:id > normalize + broadcast | routes_test.go:222 TestManualDecisions/"normalizes keywords and enabled, and returns success"; broadcast: routes_test.go:675 TestSSEBroadcastOnDecisionMutation | covered |
| 32 | PUT /:id > forbidden target subcat | routes_test.go:251 TestManualDecisions/"rejects a forbidden target subcategory without calling the store" | covered |
| 33 | PUT /:id > generic target category | routes_test.go:265 TestManualDecisions/"rejects a generic target category without calling the store" | covered |
| 34 | PUT /:id > 404 | routes_test.go:276 TestManualDecisions/"returns 404 when the decision does not exist" | covered |
| 35 | DELETE /:id > delete one | routes_test.go:285 TestManualDecisions/"deletes a single decision" | covered |
| 36 | DELETE /:id > 404 | routes_test.go:294 TestManualDecisions/"returns 404 when deleting a missing decision" | covered |
| 37 | DELETE > clear all | routes_test.go:303 TestManualDecisions/"clears every decision" | covered |
| 38 | PUT registers decision on re-classify | documents_write_docs_test.go:80 TestPutDocumentRoute/"records a manual decision when the edit re-classifies (Golden Rule 18)" | covered |
| 39 | PUT no decision for summary-only | documents_write_docs_test.go:95 TestPutDocumentRoute/"does not record a decision for a non-classification edit" | covered |
| 40 | watcher > kicks off scan | watcher_test.go:37 TestWatcherKicksOffScanForUnblockedPDFs | covered |
| 41 | watcher > nothing with no PDFs | watcher_test.go:86 TestWatcherDoesNothingWithNoPDFs | covered |
| 42 | watcher > skip unchanged blocked | watcher_test.go:98 TestWatcherSkipsUnchangedBlockedFile | covered |
| 43 | watcher > no overlap with manual scan | watcher_test.go:143 TestWatcherDoesNotOverlapManualScan | covered |
| 44 | watcher > TOCTOU mid-loop (RED) | watcher_test.go:161 TestWatcherClaimsGuardBeforeBlockedCheck; documents_write_race_test.go:44 TestWatcherAndManualScanAtMostOne; 409 via documents_write_test.go:229 | covered (red-pinned; see §4) |
| 45 | open-chrome > 404 missing file | routes_test.go:322 TestOpenChrome/"returns 404 if the target file path does not exist" | covered |
| 46 | open-chrome > spawn argv, no shell | routes_test.go:330 TestOpenChrome/"launches Chrome with the file path as an argv entry and never a shell string" | covered |
| 47 | open-chrome > 400 missing targetPath | routes_test.go:356 TestOpenChrome/"returns 400 if targetPath is missing" | covered |
| 48 | open-folder > spawn argv | documents_read_test.go:527 TestOpenFolder/"opens the file manager via spawn with an argument array" | covered |
| 49 | open-folder > 404 missing file | documents_read_test.go:565 TestOpenFolder/"returns 404 when the document file is missing on disk" | covered |
| 50 | /:id/file > 404 missing id | documents_read_test.go:394 TestDocumentFileAndFileByPath/"returns 404 if document ID does not exist" | covered |
| 51 | file-by-path > 404 missing path (RED) | documents_read_test.go:415 TestDocumentFileAndFileByPath/"pins the known-red drive-letter candidate at the actual 403 (upstream expects 404)"; 404 managed-missing: :402 | covered (red-pinned; see §4) |
| 52 | file-by-path > reject outside | documents_read_test.go:429 TestDocumentFileAndFileByPath/"rejects a path outside the managed directories" | covered |
| 53 | file-by-path > reject traversal | documents_read_test.go:437 TestDocumentFileAndFileByPath/"rejects a traversal attempt that escapes the managed root" | covered |

### 2b. task-state.test.ts (3 cases)

| # | Upstream case | Go test (file: func/subtest) | Verdict |
|---|---------------|------------------------------|---------|
| T1 | starts with an idle state | app/taskstate/taskstate_test.go:22 TestTaskState/"starts with an idle state" | covered |
| T2 | start/update/finish flow | app/taskstate/taskstate_test.go:33 TestTaskState/"updates state when startTask, updateTaskProgress, and finishTask are called" | covered |
| T3 | failTask | app/taskstate/taskstate_test.go:68 TestTaskState/"handles failTask properly" | covered |

Go also re-asserts task state at the HTTP layer (`routes_test.go:606,615,626 the status/unlock subtests`).

**Why 15 and 19 are UNCOVERED:** case 15's side effect is "relocalize NOT called"; the Go test
`documents_write_docs_test.go:26` uses `samplePutDoc()` with an empty `NewPath`
(`documents_write_docs_test.go:15-21`) so the branch is skipped, but it never asserts
`env.reloc.relocalizeCalls == 0` — the fake increments silently (`documents_write_fakes_test.go:134-144`)
and its no-op default (`:122-124`) cannot fail the test. Case 19's SSE side effect:
the handler does broadcast `REGISTRY_UPDATED/EDIT` (`documents_write_docs.go:318`), but no Go test
connects the triage stream around a `PUT /api/documents/{id}`; grep of `"EDIT"` in `httpapi/*_test.go`
returns no match.

### 2c. Extra Go coverage (not required by the mapping, evidence parity is stronger than upstream)

Goldens exist for fixed bodies: `httpapi/testdata/golden/*.json` driven by
`golden_test.go:65 TestGoldenContract`, `documents_read_golden_test.go:85 TestDocumentReadGolden`,
`documents_write_golden_test.go:19 TestGoldenDocWriteContract`; SSE frame goldens
`golden_test.go:332,364`; helper-algorithm parity `documents_read_helpers_test.go:6`. Routes with no
upstream case get derived cases: #26 CSV `documents_read_test.go:767`, #30 MCP `:741`, #31 zip `:662`,
#34 source-image `:585`.

---

## 3. BEHAVIOR GAPS

### 3a. Deliberate, documented deviations (NOT gaps)

| # | Deviation | Evidence |
|---|-----------|----------|
| D1 | ServeMux answers **405 + Allow** where Express answers 404 for a known path/unknown method | server.go:53-56 |
| D2 | Live-reload change source is a **polling mtime/size watcher**, wire format unchanged (`data: reload`) | livereload.go:6-9, 75-78 |
| D3 | SSE fan-out is a mutex hub with a **per-client buffered channel** (events dropped for a full buffer) instead of synchronous `res.write` | sse.go:4-8, 29-31; triage.go:21-38 |
| D4 | logs/stream listener **enqueues** and the handler goroutine writes, because Go forbids cross-goroutine ResponseWriter writes | logs.go:98-101, 121-140 |
| D5 | Zod's pretty-printed issue array replaced by plain `{error:<string>}` (400 kept) | server.go:69-71, 411-414; open.go:134-169 reproduces Zod text only for missing/empty targetPath |
| D6 | Registration order replaced by ServeMux specificity for `/api/documents/export/*` vs `/{id}` | documents_read.go:26-32; test :374 |
| D7 | `app/taskstate`, `triagescan.Result`, `relocalize.*` have no JSON tags, so HTTP emits explicit maps/structs with the frozen camelCase keys | server.go:57-59, 440-476; documents_write.go:81-90, 316-337; documents_write.go:411-440 |

### 3b. Real gaps (Go does not reproduce TS behavior)

| # | Gap | TS evidence | Go evidence | Impact |
|---|-----|-------------|-------------|--------|
| **G1** | **Image import >100 kB is rejected.** TS's global `express.json()` only parses `application/json` (limit 100 kB), so the route's `express.raw({type:'application/octet-stream',limit:'64mb'})` sees the whole photo. Go's `jsonBodyMiddleware` reads **every** body with a 100 kB cap and answers 413 before the handler. | web-server.ts:60 (json), :844-845 (raw 64mb) | server.go:113-115, 360-376; documents_write_files.go:125-135; test locking the gap: documents_write_files_test.go:101-109 ("reported gap 1") | Real uploads >100 kB fail through the composed server; the 64 MB cap is only reachable by a direct handler call |
| **G2** | **`/api/images/import` ignores Content-Type.** TS only populates `req.body` when the request is `application/octet-stream`, then requires `Buffer.isBuffer(req.body)`; a JSON body → 400 "Empty image body." Go returns the raw bytes for **any** content type, so a JSON body with `?filename=x.png` is written as an image. | web-server.ts:844-845, 859-861 | documents_write_files.go:54-77, 129-147 (`readImportBody` reads context/body unconditionally) | Wrong-content-type request succeeds instead of 400 |
| **G3** | **`PUT /api/manual-decisions/:id` with malformed JSON proceeds.** `express.json()` rejects malformed JSON with 400 before the handler. Go's `jsonBodyMiddleware` does not parse; `buildDecisionPatch` swallows the unmarshal error and the handler still calls `UpdateManualDecision` → 200. | web-server.ts:60, 558-601 | server.go:360-376; decisions.go:117-125 (`if err != nil { return patch }`), :65 | Malformed body → 200 instead of 400 |
| **G4** | **`GET /api/logs/recent?limit=<non-numeric>`**: TS `parseInt('abc',10)` → NaN and passes NaN to `getRecentLogs`; Go keeps the 300 default when `Atoi` fails. | web-server.ts:445-446 | logs.go:70-75 | Different log count returned |
| **G5** | **`GET /api/categories` injected DB-only subcategory order**: TS iterates the stats object's own key order (insertion order from `GROUP BY`); Go sorts alphabetically. | web-server.ts:505-515 | categories.go:55-64 (`sort.Strings(injected)`) | Same set, different order |
| **G6** | **Configured subcategories always emit `"subcategories": []`.** TS spreads the stored object (`{...sub, count}`), so the key is absent when the source omitted it; Go's `subcategoryView` always adds it. | web-server.ts:499-502 | categories.go:106-123 (nested always set) | Extra key in the response |
| **G7** | **Repair `FILE_FAILED` raises a TASK_PROGRESS.** TS's repair progress block only handles `REPAIR_STARTED` and `FILE_PROGRESS`/`FILE_COMPLETED`; Go adds a `FileFailedEvent` case that calls `UpdateTaskProgress` with count 0 (and sets empty Stage/CurrentFile pointers where TS leaves undefined). | web-server.ts:263-270 | documents_write_scan.go:140-160 | Extra TASK_PROGRESS frame / task-state churn during repair |

Also worth noting (no action implied): `system.go:267-281 formatBytes` reimplements JS
`toFixed(2)`+`parseFloat`; Go `strconv.FormatFloat` and JS `toFixed` can differ on exact-half
decimals. `GET /api/documents/:id/file` intentionally has **no** path guard in both
(web-server.ts:1167-1175 vs documents_read.go:369-399), matching TS.

### 3c. Golden Rule guards requested

| Rule | TS | Go | Test |
|------|----|----|------|
| 1 scan scope (input dir only) | web-server.ts:1436 `getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR)` | watcher.go:207 | watcher_test.go:62 TestWatcherWalksOnlyTheInputDir |
| 3 no-text block retention | web-server.ts:1441-1445 mtime/size skip | watcher.go:219-227 | watcher_test.go:98 TestWatcherSkipsUnchangedBlockedFile |
| 4 forbidden subcategory | web-server.ts:586, :1262 | decisions.go:52-57 (guards.ForbiddenSubcategoryViolation), documents_write_docs.go:243-248 | routes_test.go:251; documents_write_docs_test.go:48,60 |
| 5 pre-move branch auto-create | web-server.ts:1275-1277 `ensureCategoryAndSubcategoryExist` | documents_write_docs.go:270 guards.EnsureCategoryAndSubcategoryExist (before RelocalizeFileIfNeeded :279) | documents_write_docs_test.go:107 "ensures the branch exists before relocalizing" |
| 9 sequential scan | web-server.ts:1426-1434 claim-before-await | documents_write_scan.go:39-63 atomic tryBeginScan(+cooldown) | documents_write_race_test.go:18,44 |
| 10 SSE on every mutation | → 3.1 catalogue, web-server.ts:299-312 | per-mutation broadcast: repair documents_write_scan.go:113-114; rename :120-121; delete :211; PUT :318; relocalize :391-392; clear :203-204; categories :98; decisions :74,97,109; unlock triage.go:51; scan via hub :291 | covered except PUT EDIT (case 19) |
| 15 clear semantics | web-server.ts:1346-1368 | documents_write_scan.go:165-213 | documents_write_test.go:135 |
| 16 no synthetic DDD | architecture rule | httpapi is a thin adapter over `app/*`; route groups via `RouteGroup` (hooks.go:8-20) | documents_write.go:43 package comment |
| 18 feedback teaches AI | web-server.ts:1299, :1333 | documents_write_docs.go:297-312 (record decision), :378 (reason→previousError) | documents_write_docs_test.go:80, :185 |

Broadcast-vs-response ordering matches TS everywhere: broadcast(s) then `writeJSON`
(repair documents_write_scan.go:113-119; clear :203-212; PUT documents_write_docs.go:318-328;
relocalize :391-393; restart writes first then deferred exit system.go:29-41; unlock resets task,
broadcasts, then responds triage.go:50-52).

---

## 4. THE TWO UPSTREAM RED CASES

**R1 — TOCTOU auto-watcher** (web-server.test.ts:845-876, "does not let a manual scan start while
the tick is still inside its async blocked-file-check loop"; run result: expects 409, gets 200).

- TS reality: production already claims the guard synchronously before the first `await`
  (`web-server.ts:1434` `isAutoScanning = true` precedes the `:1439-1449` blocked loop). The red is
  an order/isolation artifact of the shared `getBlockedFile` mock across app instances, documented in
  `documents_write.go:47-70`.
- Go pins the **intended** behavior, not the red assertion: `tryBeginScan` is a single
  mutex check-and-set (`documents_write_scan.go:39-47`), the watcher claims it before any blocked
  file check (`watcher.go:192`, before the loop at `:213-227`), and
  `watcher_test.go:161 TestWatcherClaimsGuardBeforeBlockedCheck` proves a manual claim fails while
  the tick is parked in `GetBlockedFile`. `documents_write_race_test.go:44
  TestWatcherAndManualScanAtMostOne` hammers a tick against `POST /api/triage/scan` and asserts
  `max concurrent scans == 1` (stronger than the upstream 409 assertion). The 409 itself is asserted
  by `documents_write_test.go:229`.

**R2 — file-by-path 404-vs-403** (web-server.test.ts:946-954; run result: expects 404, receives 403).

- TS reality: `path.isAbsolute('C:/…') === false` on POSIX, so `path.resolve` prepends cwd and the
  candidate can never sit inside a POSIX managed root; the live guard returns **403**
  (`web-server.ts:1123-1126`), contradicting the test's expected 404.
- Go pins the **actual** behavior: `app/guards/path.go` rejects a drive-letter candidate when the
  roots are not WSL mounts (`windowsDrivePathRe` branch) and returns the exact 403 message
  (`PathOutsideManagedDirectoriesViolation`); `documents_read_test.go:415` uses the upstream's exact
  candidate `C:/pdf-triage-test/__archive/nonexistent.pdf` and asserts 403 + "outside the managed".
  A genuinely managed-but-missing path still yields 404 (`documents_read_test.go:402`), matching
  `web-server.ts:1128-1130`. Guard-level proof: `routes_test.go:741 TestResolveManagedPathWrapsGuard`.

---

## COUNTS

- Routes: **46/46 covered, 0 missing, 0 extra TS routes.**
- Upstream cases: **54/56 covered** (53 web-server + 3 task-state), of which 2 are deliberate
  red-pins at actual TS behavior (#44, #51); **2 uncovered** (#15 no-new_path relocalize side effect;
  #19 PUT REGISTRY_UPDATED/EDIT SSE).
- Real gaps: **7** (G1–G7); top 5 = G1 image-import 100 kB cap, G2 image-import Content-Type,
  G3 manual-decision malformed JSON 200-vs-400, G4 logs/recent NaN limit, G5 categories injection
  order. Deliberate documented deviations: 7 (D1–D7). No Golden Rule guard is missing.
