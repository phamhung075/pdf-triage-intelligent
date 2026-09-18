# pdf-triage — application & infrastructure inventory for a full Go backend

> Evidence base for [the Go backend migration design](2026-09-18-go-backend-migration-design.md). Line numbers refer to the TypeScript sources as of 2026-09-18.

Read-only inventory. Every claim cites `file:line`. Scope: `src/application/**` and
`src/infrastructure/**` (non-test, 8,288 lines across 35 modules), the HTTP/MCP surfaces,
the SQLite layer, `package.json`, the Electron shell/build scripts, and the existing Go
submodule `services/pdf-triage-pdf2w/`. No app/server was run.

Sizes below are `wc -l` on the file, non-test.

---

## 1. Application layer (`src/application/`, 2,980 lines)

All modules are asynchronous orchestration over I/O; the only pure (no-I/O) exports are the
text/geometry helpers in `classify-document.ts`, `convert-image-document.ts` and `image-to-pdf.ts`.

### 1.1 `classify-document.ts` — 615 lines
- Responsibility: the classification pipeline Step A (entity) + Step C (zero-loss Markdown) +
  Step D (classification), then taxonomy resolution and duplicate guard. Entry `classifyPDFText`
  at `classify-document.ts:383`.
- Imports: `CONFIG` (`:1`), domain schemas/prompt/resolution/markdown-tables/quality-gate (`:2`–`:9`),
  `categories-store` (`:10`), `entity-dictionary-store` (`:11`), `prompt-personalization-store`
  (`:12`), `taxonomy-hints-store` (`:13`), `ollama-client` (`:14`).
- External I/O: filesystem (config read), Ollama HTTP via `requestClassificationCompletion` /
  `requestTextChatCompletion` (`:426`, `:462`), file writes via `saveCategoriesConfig` (`:554`,
  `:578`) and `recordTaxonomyHint` (`:543`, `:564`).
- Domain functions called: `cleanAndParseJSON`, `ruleBasedClassify`,
  `buildCategoriesDescriptionStr`, `reconcileDocumentDate` (`:4`); `buildClassificationPrompt`,
  `buildEntityExtractionPrompt`, `buildMarkdownConversionPrompt` (`:5`);
  `refineClassification`, `resolveCategory`, `resolveSubcategory`,
  `applyEntityPriorityOverride` (`:6`); `auditMarkdownTables`, `measureContentRecall`,
  `neutralizeChartLikeTables` (`:7`), `normalizeMalformedPipeRows`,
  `mergeHeaderlessContinuationBlocks`, `reattachHeadingSplitTableRows`,
  `restoreMissingTableHeaderCells` (`:8`), `describeTableRepairNote` (`:9`).
- Purity: mostly I/O, but `chunkText` (`:54`), `detectOpenTableTail` (`:95`),
  `joinChunkMarkdown` (`:134`), `splitOverlongLine` (`:37`) are pure.

### 1.2 `triage-scan.ts` — 648 lines
- Responsibility: the live scan pipeline — bundle photo folders, walk `__raws`, extract, block
  no-text / forbidden-subcategory / quality-gate files, dedupe by checksum, classify, insert,
  relocalize. Entry `runTriageScan` (`:67`).
- Imports: `fs`/`path` (`:1`–`:2`), `CONFIG` (`:3`), `acquireScanLock` (`:4`), `pdf-scanner` (`:5`),
  `pdf-extractor` (`:6`), image conversion (`:7`), `database` (`:8`–`:16`), `classifyPDFText` (`:17`),
  `generateEmbedding`/`ensureOllamaModel` (`:18`), `relocalizeFileIfNeeded` (`:19`), taxonomy (`:20`),
  quality gate (`:21`), `json-registry` (`:22`), `logger` (`:23`).
- External I/O: filesystem walk/stat/rename (`:127`, `:161`), pdf2w HTTP (via extractor),
  Ollama HTTP (`:90`, `:336`), SQLite (`:162`, `:340`, `:435`), JSON registry (`:526`).
- Domain functions: `isForbiddenSubcategory` (`:302`), `assessExtractionQuality` (`:331`).
- Progress events emitted: `OLLAMA_DOWN` (`:97`), `FILE_PROGRESS` (`:114`, `:183`, `:278`, `:420`),
  `SCAN_STARTED` (`:131`), `FILE_FAILED` (`:166`, `:232`, `:317`, `:493`, `:511`),
  `FILE_COMPLETED` (`:263`, `:405`, `:451`), `SCAN_COMPLETED` (`:528`).
- Purity: I/O orchestration; helpers `moveDuplicateFileToDuplicatesFolder` (`:546`),
  `cleanEmptyDirectories` (`:576`), `moveBlockedFileToBlockedFolder` (`:620`) are filesystem I/O.

### 1.3 `relocalize-document.ts` — 390 lines
- Responsibility: compute canonical path, move files atomically, re-analyze a document, delete to
  trash. Exports `relocalizeFileIfNeeded` (`:47`), `moveBackToRaws` (`:108`),
  `findActualFileOnDisk` (`:142`), `ensureCategoryAndSubcategoryExist` (`:166`),
  `reclassifyAndRelocalizeDocument` (`:191`), `deleteDocumentAndMoveToTrash` (`:345`).
- Imports: `fs`/`path` (`:1`–`:2`), `computeCanonicalPathRemote` (`:5`), `pdf-scanner` (`:6`),
  `categories-store` (`:7`), `pdf-extractor` (`:8`), `classifyPDFText` (`:9`), `json-registry` (`:10`),
  `database` (`:11`), `logger` (`:12`), `recordManualDecision` (`:13`).
- External I/O: HTTP to the Go canonical-path service (`:55`), filesystem link/rename/rmdir
  (`:29`–`:38`, `:88`), pdf2w + clean-text HTTP via extractor (`:228`), SQLite (`:121`, `:216`,
  `:377`), JSON registry (`:333`, `:382`).
- Domain functions: `isForbiddenSubcategory` (`:208`).
- Purity: I/O; `renameAtomicNoOverwrite` (`:21`) is a filesystem primitive.

### 1.4 `convert-image-document.ts` — 379 lines
- Responsibility: photo → archivable A4 PDF (orient/crop/enhance/assemble), then pdf2w text, then
  park the source in `.delete_files/img_converted`. Exports `convertImageToPdf` (`:264`),
  `convertImageFolderToPdf` (`:323`), `findImageBundleFolders` (`:234`), `isImageFile` (`:33`),
  `sortImagePagesNaturally` (`:201`), `listBundleImages` (`:209`).
- Imports: `fs`/`path`/`crypto` (`:1`–`:3`), `pdf-lib` `PDFDocument` (`:4`), `image-to-pdf` (`:5`),
  `pdf-extractor` (`:6`), `encodeJpeg` from `image-processor` (`:7`), `fitImageToA4` (`:8`),
  `logger` (`:9`), `CONFIG` (`:10`).
- External I/O: filesystem read/write/rename (`:130`, `:185`, `:103`), pdf2w HTTP (`:283`, `:341`),
  `@napi-rs/canvas` via `image-processor` for EXIF decode and orientation/crop/enhance calls
  through `image-to-pdf.ts`.
- Domain functions: `fitImageToA4` (`:164`).
- Purity: `sortImagePagesNaturally` (`:201`), `findImageBundleFolders`' traversal decision (`:248`);
  the rest is I/O.

### 1.5 `image-to-pdf.ts` — 134 lines
- Responsibility: Vision-Lab step functions `runOrientStep` (`:40`), `runCropStep` (`:82`),
  `runEnhanceStep` (`:116`). Step 4 (extract) retired (`:132`–`:134`).
- Imports: `orientation-detector` (`:1`), `crop-detector` (`:2`), `image-processor` (`:3`),
  `AUTO_ADJUST_SHARPNESS` (`:4`), `logger` (`:5`).
- External I/O: Ollama vision HTTP (through the detectors), `@napi-rs/canvas` (through
  `image-processor`), filesystem none directly.
- Domain functions: `AUTO_ADJUST_SHARPNESS` (`:4`).
- Purity: orchestration with I/O at each step; each returns an error instead of throwing (`:73`).

### 1.6 `repair-registry.ts` — 269 lines
- Responsibility: purge ghost rows, re-extract every archive file, fix generic categories,
  relocalize, backfill contacts, insert unindexed files. Entry `repairRegistry` (`:19`).
- Imports: `fs`/`path` (`:1`–`:2`), settings (`:3`), `acquireScanLock` (`:4`), `database` (`:5`),
  taxonomy (`:6`), `categories-store` (`:7`), `pdf-scanner` (`:8`), `pdf-extractor` (`:9`),
  relocalize helpers (`:10`), `ruleBasedClassify`/`extractRuleBasedContact` (`:11`),
  `entity-dictionary-store` (`:12`), `prompt-personalization-store` (`:13`), `classifyPDFText`
  (`:14`), `generateEmbedding` (`:15`), `json-registry` (`:16`), `logger` (`:17`).
- External I/O: filesystem (`:40`, `:68`), pdf2w/clean-text HTTP (`:79`), Ollama HTTP (`:107`,
  `:173`, `:175`), SQLite (`:33`, `:43`, `:98`, `:194`), JSON registry (`:257`).
- Domain functions: `isYearString`, `findCanonicalCategoryForSubcategory` (`:6`),
  `ruleBasedClassify`, `extractRuleBasedContact` (`:11`).
- Purity: I/O.

### 1.7 `clear-registry.ts` — 95 lines
- Responsibility: move every archive file back to `__raws`, purge `documents` + FTS, move orphan
  archive files, remove empty dirs, resync JSON. Entry `clearRegistryAndMoveArchiveToRaws` (`:10`).
- Imports: settings (`:3`), `acquireScanLock` (`:4`), `database` (`:5`), relocalize helpers (`:6`),
  `isPathInsideDir` (`:7`), `json-registry` (`:8`).
- External I/O: filesystem (`:30`, `:60`–`:85`), SQLite (`:50`, `:52`), JSON registry (`:88`).
- Domain functions: `isPathInsideDir` (`:30`).
- Purity: I/O.

### 1.8 `ai-chat-assistant.ts` — 321 lines
- Responsibility: retrieval for chat — FTS5 over `documents_fts`, relax ladder, token-scorer last
  resort, pay-slip dedupe, prompt build, Ollama answer, citation pruning. Exports
  `searchRelevantDocuments` (`:71`), `dedupeByPeriod` (`:143`), `retrieveDocuments` (`:163`),
  `buildPromptContext` (`:218`), `processChatQuery` (`:245`).
- Imports: `getAllDocuments`, `searchDocumentsFts`, `DocumentRecord` (`:1`),
  `requestTextChatCompletion` (`:2`), `detectFileType` (`:3`), `formatLocalDate` (`:4`),
  `logger` (`:5`), `buildFtsMatchExpression`, `relaxQuery` (`:6`), `planQuery` (`:7`).
- External I/O: SQLite (`:72`, `:189`), Ollama HTTP (`:253`).
- Domain functions: `detectFileType` (`:221`, `:289`), `formatLocalDate` (`:228`),
  `buildFtsMatchExpression`/`relaxQuery` (`:186`, `:198`).
- Purity: `parseDocDate` (`:22`), `extractRequestedCount` (`:50`), `paySlipPeriodKey` (`:126`),
  `dedupeByPeriod` (`:143`), `buildPromptContext` (`:218`) are pure; retrieval is I/O.

### 1.9 `chat-query-planner.ts` — 79 lines
- Responsibility: turn free text into a `StructuredQuery` via Qwen, falling back to the heuristic
  planner (`:61`–`:78`).
- Imports: `chat-query` schema/heuristic (`:1`–`:5`), `cleanAndParseJSON`/`formatLocalDate` (`:7`),
  `requestTextChatCompletion` (`:8`), `getCategoriesConfig` (`:9`), `logger` (`:10`).
- External I/O: Ollama HTTP (`:67`), filesystem taxonomy read (via `getCategoriesConfig`).
- Domain functions: `buildFtsMatchExpression` (`:70`), `planQueryHeuristic` (`:62`),
  `cleanAndParseJSON` (`:69`), `formatLocalDate` (`:25`).
- Purity: `buildPlannerPrompt` (`:17`) pure.

### 1.10 `scan-lock.ts` — 54 lines
- Responsibility: cross-process scan guard over `.scan.lock`, plus in-process ownership.
  `acquireScanLock` (`:35`) throws `ScanInProgressError` (`:17`) when held.
- Imports: `DATA_DIR` (`:2`), `readActiveLockHolder`/`acquireProcessLock` (`:3`).
- External I/O: filesystem lock file (`:15`, `:43`), `process.kill` (`:6`).
- Purity: lock state machine, I/O-bound.

---

## 2. Infrastructure layer (`src/infrastructure/`, 5,308 lines)

### 2.1 Config, logging, locking
- `settings.ts` (297): `BASE_DIR` derived from module URL or `PDF_TRIAGE_BASE_DIR` (`:15`–`:18`);
  `DATA_DIR` or `PDF_TRIAGE_DATA_DIR` (`:41`–`:43`); `.env` loading (`:51`–`:52`); the `CONFIG`
  object (`:133`–`:208`); pure sanitizers (`:99`, `:112`, `:123`, `:128`); `reloadConfigFromDisk`
  (`:210`); `updateConfig` writing `settings.json` (`:220`, `:244`); `ensureDirectoriesExist`
  (`:248`). I/O: fs, dotenv, path, url.
- `logger.ts` (265): `LOG_ROOT` (`:35`), `LOG_DIR`/`LOG_FILE` (`:48`–`:51`),
  `EventEmitter` `logEmitter` (`:53`), 1,000-entry ring buffer (`:56`–`:58`),
  `formatLogMessage` (`:89`), size rotation `rotateLogIfNeeded` (`:142`), `writeToFile` (`:173`),
  `getRecentLogs` (`:190`), `getGroupedSessionLogs` (`:194`), `logger` with `forDocument` (`:235`).
  I/O: fs append/rename. Pure: `extractFilenameFromLog` (`:66`), `formatLogMessage`.
- `pid-lock.ts` (72): `isProcessRunning` via `process.kill(pid,0)` (`:4`), `readActiveLockHolder`
  (`:16`), `acquireProcessLock` (`:28`), Windows `netstat -ano -p tcp` parse (`:41`–`:55`),
  `killProcessOnPort` via `taskkill /PID /F` (`:65`–`:71`). I/O: fs, child_process, OS.
- `http/task-state.ts` (109): in-memory `ActiveTaskState` (`:15`), broadcaster hook (`:29`),
  `startTask` (`:39`), `updateTaskProgress` (`:56`), `finishTask` (`:75`), `failTask` (`:85`),
  `resetTaskState` (`:94`). Pure state; emits `TASK_*` events through the broadcaster.
- `json-registry.ts` (73): `syncJSONRegistry` (`:23`) reads all docs and writes the JSON mirror via
  temp-file + atomic rename, with EPERM/EBUSY copy fallback (`:53`–`:60`). I/O.

### 2.2 Taxonomy / prompt / decision stores
- `categories-store.ts` (114): built-in defaults (`:6`–`:21`); `readCategoriesFile` (`:23`);
  `loadPublicCategories`/`loadPrivateCategories` (`:35`/`:39`); `mergeCategories` (`:48`);
  `getCategoriesConfig` merging public + private and stripping forbidden subcategories (`:68`);
  `saveCategoriesConfig` diffing writes into `.categories.private.json` (`:92`–`:110`) and firing
  `onCategoryCreatedCallback` (`:111`). I/O fs. Domain: `CategoriesConfigSchema` (`:3`),
  `isForbiddenSubcategory` (`:4`).
- `entity-dictionary-store.ts` (69): stat/mtime/size cache (`:24`, `:41`–`:63`),
  `getEntityDictionary` (`:41`). I/O fs. Domain: `EntityDictionarySchema` (`:3`).
- `prompt-personalization-store.ts` (64): `getPromptPersonalization` (`:28`) reads
  `.prompts.private.json`, appends learned priority rules (`:41`) and taxonomy-hint block (`:53`).
  I/O fs. Domain: `PromptPersonalizationSchema`, `EMPTY_PROMPT_PERSONALIZATION` (`:3`–`:7`),
  `renderTaxonomyConflictHintsBlock` (`:8`), `decisionsToPriorityRules` (`:9`).
- `manual-decisions-store.ts` (315): absolute-path guard (`:16`); JSON mirror helpers (`:75`, `:92`);
  `recordManualDecision` inserting into SQLite and mirroring JSON (`:101`–`:160`);
  `readManualDecisionsSync` (`:169`); `getManualDecisions` (`:194`); `updateManualDecision` (`:225`);
  `deleteManualDecision` (`:283`); `clearManualDecisions` (`:310`). I/O: SQLite, fs. Domain:
  `deriveRuleKeywords` (`:6`).
- `taxonomy-hints-store.ts` (69): cap 50 (`:14`), `recordTaxonomyHint` atomic temp+rename (`:30`),
  `readTaxonomyHintsSync` mtime cache (`:55`). I/O fs. Domain: `TaxonomyHintEntry` (`:4`).
- `zip-builder.ts` (105): pure-stdlib ZIP writer `createZipArchive` (`:16`) and `crc32` (`:99`);
  only reads a file when `entry.path` is set (`:23`). Nearly pure; no native deps.

### 2.3 OS launch
- `os-open.ts` (91): the only module allowed to know `explorer.exe`/Chrome/`xdg-open`
  (`:1`–`:13`); `revealInFileManager` (`:31`), `openDirectory` (`:39`),
  `resolveChromeExecutable` (`:51`), `openInChrome` (`:82`). I/O: fs.existsSync, env. Domain:
  `isWslMountPath`, `wslToWindowsPath` (`:16`). Returns `{cmd,args}`; caller spawns.

### 2.4 DB
- `db/database.ts` (645): see §5.
- `pdf-scanner.ts` (57): `SUPPORTED_EXTENSIONS` (`:5`), `getPDFsRecursively` (`:17`) skipping
  dot/dedup/blocked dirs (`:31`), `getAllFilesRecursively` (`:42`). I/O fs. Domain:
  `isPathInsideDir` (`:3`).

### 2.5 Extraction / remote services
- `pdf2w-remote.ts` (54): `extractPdf2wContent` (`:19`) POSTs raw bytes to `${PDF2W_SERVICE_URL}/convert`
  with `x-file-name` (`:28`–`:36`); requires markdown in response (`:43`). HTTP I/O.
- `clean-text-remote.ts` (32): `cleanExtractedTextRemote` (`:9`) POST `/clean-text` (`:16`). HTTP I/O.
- `canonical-path-remote.ts` (46): `computeCanonicalPathRemote` (`:9`) POST `/canonical-path` (`:23`).
  HTTP I/O.
- `pdf-extractor.ts` (58): `sanitizeDocumentNoise` (`:25`, pure); `extractPDFContent` (`:44`)
  delegates to pdf2w, computes sha256 locally as dedupe key (`:52`), then clean-text (`:53`).
- `ollama-client.ts` (171): `OllamaUnavailableError` (`:11`), down-pattern classifier (`:20`),
  `checkModelCanGenerate` with 5-min cache (`:48`), `ensureOllamaModel` with auto-pull and
  auto-spawn `ollama serve` (`:64`–`:97`), `requestClassificationCompletion` with `format:'json'`,
  `think:false`, `num_ctx:16384`, `num_predict:4096` (`:103`–`:124`),
  `requestTextChatCompletion` returning `doneReason` (`:138`), `generateEmbedding` (`:160`).
  HTTP + child_process I/O.
- `vision-client.ts` (75): `detectOrientation` (`:30`) and `detectCropBox` (`:50`) call the pinned
  Ollama vision model; `loadImage` from `@napi-rs/canvas` for dimensions (`:2`, `:52`). HTTP + native I/O.
- `orientation-detector.ts` (33): `detectOrientationCascade` (`:20`) combines EXIF
  (`parseExifOrientation`/`exifOrientationToDegrees`) with the vision model. I/O via model.
- `crop-detector.ts` (99): `detectCropBoxCascade` (`:71`) three-valued local detector vs. vision
  model; IoU threshold 0.5 (`:17`), veto short-circuit (`:77`). I/O via model + `@napi-rs/canvas`.
- `image-processor.ts` (219): `@napi-rs/canvas` operations — `normalizeOrientation` (`:22`),
  `encodeJpeg` (`:39`), `rotateImage` (`:46`), `detectDocumentBoxLocally` (`:81`),
  `cropImage` (`:139`), `computeAutoLevelsForImage` (`:153`), `applyBrightnessContrast` (`:173`),
  `applySharpen` (`:188`). Domain: image-adjust (`:3`), flood-crop (`:4`). Native I/O.

### 2.6 HTTP / MCP (summarized here; detailed in §3–§4)
- `http/web-server.ts` (1,595), `mcp/mcp-server.ts` (581).

---

## 3. HTTP surface (`src/infrastructure/http/web-server.ts`)

`createWebServer()` (`:53`). `express.json()` (`:60`); **no CORS, no auth layer** by design
(`:56`–`:59`). Static `public/` served `no-store` (`:77`–`:79`). Path-boundary guard
`resolveManagedPath` confines all file paths to `INPUT_DIR`/`OUTPUT_ROOT_DIR` (`:38`–`:45`).
Importable image extensions (`:51`). Guards: in-memory `isAutoScanning` (`:84`) and
`manualStopCooldownUntil` (`:86`); `scanAbortRequested` (`:1397`).

Routes (registration order; Express matches in order):

| # | Method | Path | Line | Request / response |
|---|--------|------|------|--------------------|
| 1 | GET | `/api/dev/livereload` | `:90` | SSE; `data: reload` on `fs.watch(publicDir)` (`:108`–`:114`) |
| 2 | POST | `/api/open-location` | `:118` | `{targetPath}` z.string min1 → opens Explorer/`xdg-open` (`:129`) |
| 3 | POST | `/api/open-chrome` | `:148` | `{targetPath}` → spawn Chrome (`:173`) |
| 4 | GET | `/api/ollama/status` | `:184` | `{online,model,host,modelsCount,models[],modelExists,modelCanGenerate,modelError}` |
| 5 | GET | `/api/ollama/models` | `:213` | `?host=` → `{online,models[]}` |
| 6 | POST | `/api/ollama/start` | `:226` | `exec('ollama serve')` (`:228`) |
| 7 | POST | `/api/server/restart` | `:240` | responds then `process.exit(0)` (`:243`–`:246`) |
| 8 | GET | `/api/triage/status` | `:250` | `getTaskState()` |
| 9 | POST | `/api/registry/repair` | `:255` | 409 if scanning (`:256`); `repairRegistry` |
| 10 | GET | `/api/config/setup-state` | `:288` | `{configured,dataDir,defaults}` |
| 11 | GET | `/api/config` | `:314` | `{language,input_dir,output_root_dir,ollama_model,ollama_host,personal_name_denylist}` |
| 12 | GET | `/api/system/stats` | `:330` | recursive size/count + format breakdown (`:332`–`:374`) |
| 13 | PUT | `/api/config` | `:422` | `SystemSettingsSchema` (`:424`) → `updateConfig` |
| 14 | GET | `/api/logs/recent` | `:443` | `?limit` (default 300) → `{logs}` |
| 15 | GET | `/api/logs/sessions` | `:454` | `{total,sessions}` |
| 16 | GET | `/api/logs/stream` | `:464` | SSE: `INIT` (`:474`) then `LOG` (`:477`); listener removed on close (`:482`) |
| 17 | GET | `/api/categories` | `:489` | taxonomy + DB counts; injects DB-only subcategories (`:505`–`:515`) |
| 18 | GET | `/api/blocked-files` | `:535` | `{total,files}` |
| 19 | GET | `/api/manual-decisions` | `:545` | `{total,decisions}` |
| 20 | PUT | `/api/manual-decisions/:id` | `:558` | patch; rejects forbidden subcat (`:586`) and generic category (`:589`) |
| 21 | DELETE | `/api/manual-decisions/:id` | `:606` | deletes one (`:612`) |
| 22 | DELETE | `/api/manual-decisions` | `:624` | clears all (`:626`) |
| 23 | PUT | `/api/categories` | `:635` | `CategoriesConfigSchema` (`:637`) → `saveCategoriesConfig` |
| 24 | POST | `/api/subcategories/rename` | `:650` | `{category,oldSubcategory,newSubcategory}`; merges taxonomy (`:668`) + relocalizes matching docs (`:674`–`:687`) |
| 25 | GET | `/api/documents` | `:703` | `?q&category&subcategory`; JS filtering (`:710`–`:727`); raw_text truncated to 800 (`:739`) |
| 26 | GET | `/api/documents/export/csv` | `:766` | `?q&category&subcategory`; CSV UTF-8 BOM (`:820`) |
| 27 | POST | `/api/images/import` | `:844` | `express.raw({type:'application/octet-stream',limit:'64mb'})` (`:845`); `?filename`; writes `wx` into `__raws` (`:870`) |
| 28 | POST | `/api/pdf/merge` | `:889` | `{filepaths[],outputFilename}`; pdf-lib (`:896`–`:916`); path-guarded (`:899`) |
| 29 | POST | `/api/chat` | `:929` | `{message,history}` → `processChatQuery` (`:936`) |
| 30 | GET | `/api/mcp/status` | `:944` | dynamic import of MCP `listMcpTools` (`:946`) |
| 31 | POST | `/api/documents/package-zip` | `:960` | `{docIds[],zipName}`; `createZipArchive` (`:989`) |
| 32 | POST | `/api/documents/:id/open-folder` | `:1001` | `revealInFileManager` (`:1019`) |
| 33 | POST | `/api/pdf/split` | `:1029` | `{filepath}`; pdf-lib per-page writes into `__raws` (`:1051`–`:1058`) |
| 34 | GET | `/api/documents/:id/source-image` | `:1080` | serves retained photo with MIME by ext (`:1098`–`:1104`) |
| 35 | GET | `/api/documents/file-by-path` | `:1112` | `?path`; path-guarded (`:1123`); serves PDF inline |
| 36 | GET | `/api/documents/:id` | `:1141` | full record, tags parsed (`:1151`) |
| 37 | GET | `/api/documents/:id/file` | `:1159` | inline PDF from `new_path||original_path` (`:1167`) |
| 38 | GET | `/api/documents/export/markdown` | `:1185` | ZIP of every `.md` (`:1204`); registered before `:id/markdown` on purpose (`:1181`–`:1184`) |
| 39 | GET | `/api/documents/:id/markdown` | `:1216` | `.md` download with RFC 6266 name (`:1228`, `:1532`) |
| 40 | DELETE | `/api/documents/:id` | `:1236` | `deleteDocumentAndMoveToTrash` (`:1239`) |
| 41 | PUT | `/api/documents/:id` | `:1251` | `UpdateDocumentSchema` (`:1255`); forbidden subcat guard (`:1262`); relocalizes (`:1278`); records manual decision (`:1299`) |
| 42 | POST | `/api/documents/:id/relocalize` | `:1329` | `{category,subcategory,reason}` → `reclassifyAndRelocalizeDocument` (`:1333`) |
| 43 | DELETE | `/api/documents` | `:1346` | 409 if scanning; `clearRegistryAndMoveArchiveToRaws` (`:1354`) |
| 44 | GET | `/api/triage/events` | `:1379` | SSE triage stream; clients in `triageSseClients` (`:1378`) |
| 45 | POST | `/api/triage/unlock` | `:1409` | sets abort (`:1412`), 60s cooldown (`:1415`), resets task |
| 46 | POST | `/api/triage/scan` | `:1482` | 409 if scanning (`:1483`); `runTriageScan` (`:1491`) |

### 3.1 SSE event catalogue and emitters
- Triage stream `GET /api/triage/events` (`:1379`); `broadcastTriageEvent` (`:1399`–`:1406`).
  - `TASK_STARTED`, `TASK_PROGRESS`, `TASK_FINISHED`, `TASK_FAILED` — emitted by
    `http/task-state.ts:53`, `:72`, `:82`, `:91`/`:108`, forwarded via
    `setTaskBroadcaster` (`web-server.ts:62`).
  - `SCAN_STARTED`, `FILE_PROGRESS`, `FILE_COMPLETED`, `FILE_FAILED`, `SCAN_COMPLETED`,
    `OLLAMA_DOWN` — typed at `triage-scan.ts:36`, emitted at `:97`, `:114`, `:131`, `:166`,
    `:183`, `:232`, `:263`, `:278`, `:317`, `:405`, `:420`, `:451`, `:493`, `:511`, `:528`.
  - `REPAIR_STARTED` (`repair-registry.ts:53`), `FILE_PROGRESS` (`:71`), `FILE_FAILED` (`:245`),
    then `REPAIR_COMPLETED` (`web-server.ts:272`).
  - `CLEAR_STARTED` (`clear-registry.ts:19`), `FILE_PROGRESS` (`:32`).
  - `CATEGORIES_UPDATED` — `web-server.ts:67`, `:639`, `:691`, `:1338`, `:1364`.
  - `REGISTRY_UPDATED` — `:273`, `:690`, `:1314`, `:1337`, `:1363`, `:1417`.
  - `DECISIONS_UPDATED` — `:597`, `:616`, `:627`.
  - `DOCUMENTS_UPDATED` — `:1243`.
  - `TASK_*` also originate in `task-state.ts` with the full task state object (`:53`).
- Log stream `GET /api/logs/stream` (`:464`): `INIT` (`:474`), `LOG` (`:477`).
- Live-reload `GET /api/dev/livereload` (`:90`): raw `data: reload` (`:111`).

### 3.2 Auto-watcher
`setInterval(..., 10000)` at `:1422`. Skips if `isAutoScanning` (`:1423`) or inside the 60s manual-stop
cooldown (`:1425`). Claims the guard synchronously before any `await` (`:1434`). Walks
`getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR)` (`:1436`); per file compares
`blocked.mtime_ms/size` to skip unchanged blocked bytes (`:1441`–`:1445`); if any unblocked,
resets the abort flag, `startTask('SCAN', …)` and runs `runTriageScan` (`:1453`–`:1468`).
Finally releases the guard (`:1477`).

### 3.3 Single-instance lock and port takeover
- Lock file `DATA_DIR/.server.lock` (`:1541`). `acquireSingleInstanceLock` (`:1546`) calls
  `readActiveLockHolder` and exits(1) if another live PID owns it (`:1547`–`:1551`); otherwise
  `acquireProcessLock`, released on `exit`/`SIGINT`/`SIGTERM` (`:1553`–`:1556`).
  `startWebServer` acquires it before listening (`:1559`–`:1563`).
- `attemptListen` (`:1569`): on `EADDRINUSE`, if `allowTakeover` calls `killProcessOnPort(port)`
  (netstat + taskkill, `pid-lock.ts:65`) and retries once with `allowTakeover=false`
  (`:1585`–`:1593`); otherwise exits. Any other listen error exits (`:1575`–`:1578`).
- The standalone Vision Lab server has the same takeover pattern on its own port
  (`vision-lab-server.ts:72`–`:98`).

---

## 4. MCP surface (`src/infrastructure/mcp/mcp-server.ts`, 581 lines)

Tools are declared by `listMcpTools` (`:26`) and dispatched by `handleMcpToolCall` (`:138`).

| Tool | Input schema | Behaviour / line |
|------|--------------|------------------|
| `search_documents` | `query?, category?, subcategory?, fileType?, limit?` (`:32`–`:40`) | JS filter over `getAllDocuments`, `limit` default 20 (`:140`–`:162`) |
| `get_full_document_text` | `docId` required (`:47`–`:51`) | returns record + `raw_text` (`:188`) |
| `update_document_metadata` | `docId` required; title/registre/date/category/subcategory/summary/tags (`:57`–`:69`) | `UpdateDocumentSchema` (`:226`), forbidden-subcat guard (`:236`), relocalize (`:261`) |
| `trigger_triage` | none (`:75`–`:77`) | `runTriageScan()` (`:284`); maps `ScanInProgressError` (`:289`) |
| `list_categories` | none (`:83`–`:85`) | `getCategoriesConfig()` (`:300`) |
| `prepare_dossier` | `dossierType` required, `limit?` (`:91`–`:98`) | `searchRelevantDocuments` (`:310`) |
| `get_document_markdown` | `docId` required (`:103`–`:107`) | markdown + metadata (`:336`) |
| `open_document_folder` | `docId` required (`:113`–`:119`) | `revealInFileManager` + spawn (`:388`–`:392`) |
| `package_documents` | `docIds?, dossierType?, zipName?` (`:125`–`:131`) | resolves docs, writes zip under `BASE_DIR/__packages` (`:440`–`:449`) |

Transports:
- **stdio** — `startMCPServer` creates one `Server` (`:575`) with `StdioServerTransport` (`:576`),
  connects (`:577`); no auth because local spawn is the boundary (`:495`–`:499`).
- **streamable HTTP** — `startMcpHttpTransport` (`:511`) exposes `POST /mcp` (`:516`) on
  `CONFIG.MCP_HTTP_PORT` / `MCP_HTTP_HOST` (default `3972` / `0.0.0.0`, `settings.ts:204`–`:205`).
  Stateless: each request gets a fresh `Server` + `StreamableHTTPServerTransport` with
  `sessionIdGenerator: undefined` (`:530`–`:535`). EADDRINUSE degrades to stdio-only rather than
  crashing (`:562`–`:571`).

Token auth (`POST /mcp` only, `:517`–`:524`): `Authorization: Bearer <token>` compared with
`crypto.timingSafeEqual` on equal-length buffers (`:519`–`:520`); token persisted in
`BASE_DIR/.mcp-api-token`, generated with `crypto.randomBytes(24)` (`:493`, `:501`–`:509`),
printed to console on start (`:555`).

---

## 5. SQLite schema, queries, FTS5, migrations (`src/infrastructure/db/database.ts`, 645 lines)

Driver: `sqlite3` + `sqlite` wrapper (`:1`–`:2`); single cached `Database` handle (`:7`–`:31`).
Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`,
`busy_timeout=10000` (`:20`–`:25`).

Tables created in `initSchema` (`:34`):
- `documents` (`:36`–`:71`): `id` PK, `checksum` UNIQUE NOT NULL (`:38`), title/registre/date/
  category/subcategory/summary/tags/raw_text/markdown_content, money/identity columns
  `total_amount`,`vat_amount`,`siren`,`iban`,`expiry_date`, contacts (`:52`–`:57`),
  `original_filename`/`original_path` NOT NULL, `new_path`, `file_type` default `PDF`,
  `source_image_path` (`:66`), `embedding` default `'[]'`, `status` default `PENDING`,
  `created_at`/`updated_at`.
- `categories_db` (`:73`–`:78`): created but **never read or written** anywhere — only the test
  asserts its existence (`db/database.test.ts:68`). Dead table.
- `blocked_files` (`:80`–`:88`): `original_path` PK, filename, reason, message, `mtime_ms`, size,
  `blocked_at`.
- `manual_decisions` (`:134`–`:151`): document_id, checksum, old/new category+subcategory,
  reason, `raw_text_snippet`, `rule_keywords` JSON default `'[]'`, `enabled` default 1, created_at.
- `documents_fts` FTS5 virtual table (`:177`–`:191`): `doc_id UNINDEXED`, then title,
  original_filename, original_path, new_path, registre, summary, category, subcategory, tags,
  raw_text. Column list constant `FTS_COLUMN_NAMES` (`:173`–`:176`).

Migrations (all idempotent, wrapped in try/catch):
- documents columns added if `PRAGMA table_info` shows missing: subcategory (`:94`),
  markdown_content (`:98`), amount/identity block (`:102`), contact block (`:110`),
  file_type (`:118`), source_image_path (`:122`), plus one data cleanup (`:126`).
- manual_decisions columns `rule_keywords` / `enabled` (`:157`–`:163`).
- FTS drift detection (`:196`–`:208`): compares actual PRAGMA columns against
  `FTS_COLUMN_NAMES`; drops and recreates on drift; backfills when FTS is empty and documents
  exist (`:214`–`:226`). FTS write failures are logged once per process (`:234`–`:242`).

Queries / functions:
- `insertDocumentRecord` (`:278`): INSERT 29 columns (`:310`–`:347`), then FTS INSERT (`:353`–`:369`).
- `updateDocumentRecord` (`:377`): reads existing row (`:410`), coalesces updates incl. French
  aliases (`:414`–`:434`), UPDATE (`:436`–`:444`), FTS DELETE+INSERT keyed on numeric
  `doc_id` (`:408`, `:448`–`:453`).
- `getAllDocuments` (`:461`), `getDocumentById` (`:466`), `getDocumentByChecksum` (`:471`).
- `searchDocumentsFts` (`:516`): `documents_fts MATCH ?` joined to `documents` (`:546`–`:551`),
  SQL-side filters category/subcategory/date bounds (`:525`–`:542`), ordered by
  `bm25(documents_fts, weights)` (`:550`). `BM25_WEIGHTS` (`:493`–`:505`) = title 10, tags 6,
  summary 3, category/subcategory 2, paths/registre 1, raw_text 0.5, doc_id 0.
- blocked-file helpers `getBlockedFile` (`:566`), `getAllBlockedFiles` (`:571`),
  `upsertBlockedFile` with `ON CONFLICT(original_path) DO UPDATE` (`:576`–`:597`),
  `deleteBlockedFile` (`:599`), `pruneBlockedFiles` (`:604`).
- `getCategorySubcategoryStats` (`:614`): `GROUP BY LOWER(category), LOWER(COALESCE(NULLIF(
  subcategory,''),'general'))` (`:620`–`:624`).
- Direct raw SQL also lives outside this file: `DELETE FROM documents` / `documents_fts`
  (`clear-registry.ts:50`–`:52`, `relocalize-document.ts:121`–`:123`, `:216`–`:218`, `:377`–`:379`,
  `repair-registry.ts:43`–`:45`).

---

## 6. npm dependencies → Go equivalents

`dependencies` (`package.json:39`–`:52`), `devDependencies` (`:53`–`:67`), `overrides` (`:68`–`:70`).

| npm package | Used for (evidence) | Go replacement | cgo |
|-------------|---------------------|----------------|-----|
| `@modelcontextprotocol/sdk` `:40` | MCP Server, stdio + streamable HTTP (`mcp-server.ts:5`–`:11`) | `github.com/modelcontextprotocol/go-sdk/mcp` (official; v1.8.0, stdio + HTTP transports) [pkg.go.dev](https://pkg.go.dev/github.com/modelcontextprotocol/go-sdk) | no |
| `@napi-rs/canvas` `:41` | decode/rotate/crop/encode (EXIF, JPEG/PNG/webp/bmp/tiff) (`image-processor.ts:1`, `vision-client.ts:2`, `crop-detector.ts:1`) | stdlib `image/jpeg`,`image/png`,`image/draw` + `golang.org/x/image` (`webp`,`bmp`,`tiff`,`draw`) [pkg.go.dev](https://pkg.go.dev/golang.org/x/image) | no |
| `dotenv` `:42` | `.env` load (`settings.ts:3`, `:52`) | stdlib `os`/`bufio`, or `github.com/joho/godotenv` | no |
| `express` `:43` | HTTP server + routing (`web-server.ts:1`, `vision-lab-server.ts:1`) | stdlib `net/http`; Go 1.22 `http.ServeMux` method+path patterns | no |
| `marked` `:44` | frontend Markdown only, via vendored `public/js/vendor/marked.js` (`public/ts/TriageState.ts:137`) | frontend-only; if kept server-side, `github.com/yuin/goldmark` | no |
| `ollama` `:45` | Ollama client (`ollama-client.ts:1`, `vision-client.ts:1`, `web-server.ts:7`) | stdlib `net/http` + `encoding/json`, or official `github.com/ollama/ollama/api` | no |
| `pdf-parse` `:46` | **not imported by runtime src** (only comments in `domain/pdf-text.ts:7`) | drop | — |
| `pdfjs-dist` `:47` | **not imported by runtime src** | drop | — |
| `sqlite` `:48` + `sqlite3` `:49` | async SQLite wrapper + native binding (`db/database.ts:1`–`:2`) | `database/sql` + `modernc.org/sqlite` (CGo-free transpiled SQLite 3.53.4) [pkg.go.dev](https://pkg.go.dev/modernc.org/sqlite); `mattn/go-sqlite3` only if cgo acceptable | modernc: **no**; mattn: **yes** |
| `tesseract.js` `:50` | OCR — **no runtime import** (OCR delegated to pdf2w; `pdf-extractor.ts:37`–`:43`) | drop | — |
| `zod` `:51` | runtime validation (`document.schema.ts`, used at `web-server.ts:22`, `mcp-server.ts:19`) | hand-rolled struct validation / `encoding/json` (already ported as `documentschema`); optional `github.com/go-playground/validator/v10` | no |
| `pdf-lib` `:61` (devDep, actually runtime) | PDF assembly, merge, split (`convert-image-document.ts:4`, `web-server.ts:25`, `:896`, `:1041`) | `github.com/pdfcpu/pdfcpu` (pure Go: merge/split/import images) [pkg.go.dev](https://pkg.go.dev/github.com/pdfcpu/pdfcpu) | no |
| `electron` `:59` | desktop shell (`desktop/main.cjs:1`) | `github.com/getlantern/systray` for tray, or Wails v2/v3 for a webview window | no (Wails needs OS webview) |
| `electron-builder` `:60` | portable Windows installer (`package.json:71`–`:104`) | `go build` + `goreleaser` (NSIS/zip) | no |
| `sass` `:62` | SCSS → `public/style.css` (`package.json:17`) | keep as build-time tool, or `github.com/bep/godartsass` | godartsass: **yes** |
| `tsx` `:64` / `typescript` `:65` | dev runner / compile (`package.json:8`, `:16`) | `go run` / `go build` | no |
| `vitest` `:66` / `supertest` `:63` | unit + HTTP tests | `go test` + `net/http/httptest` | no |
| `@noble/hashes` override `:68`–`:70` | transitive pin of the MCP SDK chain | not needed once the JS SDK is gone | — |

Unused-but-listed runtime deps `pdf-parse`, `pdfjs-dist`, `tesseract.js` should be dropped, not
ported. `pdf-lib` must be promoted out of `devDependencies` before the port if the JS build is kept
alongside.

---

## 7. Electron desktop shell and build scripts

- `desktop/main.cjs` (303): Electron main process. Tray icon/menu (`:200`–`:251`), single-instance
  lock via `app.requestSingleInstanceLock()` (`:269`–`:277`), auto-spawn `ollama serve` when
  `:11434/api/tags` is unreachable (`:34`–`:55`), starts the backend by dynamically importing
  `dist/index.js` (`:77`–`:86`) or falls back to spawning `npx tsx src/index.ts` (`:88`–`:105`),
  polls the server then opens a `BrowserWindow` (`:170`–`:190`, `:107`–`:165`), sets
  `PDF_TRIAGE_DATA_DIR` to Electron `userData` when packaged (`:72`–`:75`), cleans up children on
  quit (`:253`–`:266`). Replace with a small Go tray process that starts the embedded HTTP server
  on `127.0.0.1:3971` and opens the default browser, or Wails for a native window; single-instance
  via a named mutex/lock file.
- `scripts/build-exe.mjs` (113): kills stale app/electron processes (`:24`–`:25`), detects a locked
  native `sqlite3` binding and refuses to build with guidance (`:48`–`:79`), clears
  `dist-installer` (`:83`), runs `electron-builder --win` and force-exits after a 10-minute
  watchdog (`:88`–`:101`). Replaced by `go build -o …` / `goreleaser`; the native-binding lock
  problem disappears with the pure-Go SQLite driver.
- `scripts/merge-subcategories.ts` (185): one-shot taxonomy/DB migration that reuses the app's own
  machinery; not part of the runtime. Port as a `go run ./cmd/migrate` one-shot.
- `package.json` build config (`:71`–`:104`): `appId`, `productName`, `asar:false`,
  `directories.output: dist-installer`, shipped `files` list (`:78`–`:88`), `win.target: nsis, dir`
  (`:89`–`:96`), NSIS options (`:97`–`:103`). Replaced by goreleaser/NSIS config.
- npm scripts (`:7`–`:24`): `dev`/`start` tsx watch, `scan`, `mcp`, `vision:dev`,
  `clean:dist`, `build` (clean + css + tsc + frontend tsc), `build:css`, `build:frontend`,
  `watch:*`, `test`, `typecheck`, `desktop`, `dist:exe`. In Go these become subcommands of one
  binary (`serve`, `scan`, `mcp`, `vision-lab`) plus `go build`/`go test`.
- `tsconfig.json` (`:1`–`:15`) compiles `src/**` to `dist`; `tsconfig.frontend.json` (`:1`–`:22`)
  compiles `public/ts/**` to `public/js`. Frontend must be rebuilt separately
  (`package.json:19`); a Go port keeps the static `public/` assets as-is.

---

## 8. Recommended porting order (leaves → root) and Go packages consumed

Existing Go packages in `services/pdf-triage-pdf2w/` (module
`github.com/phamhung075/pdf-triage-pdf2w`, Go 1.22, **zero external deps**, `go.mod:1`–`:3`):
`canonicalpath`, `chatquery`, `cleantext`, `decisionrule`, `documentschema`, `exiforientation`,
`extractionqualitygate`, `floodcrop`, `imageadjust`, `imagedimensions`, `markdowntables`,
`pathconv`, `pdfpagefit`, `pdftext`, `promptpersonalization`, `taxonomy`, `taxonomyconflicts`.
The HTTP server only wires `canonicalpath` and `cleantext` (`cmd/server/main.go:13`–`:15`,
`:74`–`:75`).

Missing domain ports that must land first (they are still TypeScript-only):
`classification.ts` (724) → new `classification` package (`ruleBasedClassify`,
`cleanAndParseJSON`, `formatLocalDate`, `buildCategoriesDescriptionStr`, `reconcileDocumentDate`,
`extractRuleBasedContact`); `classification-resolution.ts` (265) → new `classificationresolution`;
`prompt.ts` (174) → new `prompt`. `document.schema.ts` is already ported as `documentschema`.

| Phase | Module(s) | Consumes |
|-------|-----------|----------|
| 0 | domain completion: `classification`, `classification-resolution`, `prompt` | `documentschema`, `taxonomy`, `taxonomyconflicts`, `promptpersonalization`, `decisionrule`, `markdowntables`, `pdftext` |
| 1 | `zip-builder`, `json-registry`, `pdf-scanner`, `pid-lock`, `logger`, `http/task-state` | `taxonomy` (`isPathInsideDir`) |
| 2 | `settings` (CONFIG/data dirs) | `pathconv` |
| 3 | `db/database` (modernc SQLite + FTS5; schema/migrations/BM25) | `taxonomy` (`detectFileType`) |
| 4 | stores: `categories-store`, `entity-dictionary-store`, `prompt-personalization-store`, `manual-decisions-store`, `taxonomy-hints-store` | `documentschema`, `taxonomy`, `taxonomyconflicts`, `promptpersonalization`, `decisionrule` |
| 5 | remote adapters: `pdf2w-remote`, `clean-text-remote`, `canonical-path-remote`, `pdf-extractor`, `ollama-client` | existing `cleantext`, `canonicalpath` (or in-process call), plus `pdftext` |
| 6 | image/vision adapters: `image-processor`, `vision-client`, `orientation-detector`, `crop-detector` | `floodcrop`, `imageadjust`, `exiforientation`, `imagedimensions`, `pdfpagefit` |
| 7 | application: `image-to-pdf`, `convert-image-document`, `relocalize-document`, `classify-document`, `chat-query-planner`, `ai-chat-assistant`, `triage-scan`, `repair-registry`, `clear-registry`, `scan-lock` | all of phases 0–6; `pdfpagefit`, `extractionqualitygate`, `markdowntables`, `chatquery`, `taxonomy`, `taxonomyconflicts` |
| 8 | `http/web-server` (REST+SSE), `mcp/mcp-server`, `vision-lab-server` | phase 7 + MCP SDK; `canonicalpath`, `cleantext` |
| 9 | composition root (`index.ts` subcommands) and `desktop/main.cjs` replacement | everything above |

---

## 9. Riskiest items

1. **Native image stack replacement.** `@napi-rs/canvas` is used for EXIF normalization,
   rotation, crop, auto-levels, sharpen and JPEG/PNG/webp/bmp/tiff I/O
   (`image-processor.ts:22`–`:218`, `vision-client.ts:52`). A Go port must reproduce exact pixel
   semantics (JPEG quality 0–100, EXIF auto-apply behaviour, `Float32` flood-crop input) or the
   crop/orientation invariants break (Golden Rule 17). `floodcrop`/`imageadjust` are already
   ported, but the decode/encode seam is not.
2. **SQLite + FTS5 parity.** `documents_fts` is a custom FTS5 table with drift detection and a
   specific `bm25()` weight vector (`database.ts:173`–`:226`, `:493`–`:553`). `modernc.org/sqlite`
   is pure Go, but FTS5 availability and exact `bm25`/MATCH behaviour must be smoke-tested against
   the existing `pdf_triage.db` before trusting it.
3. **Golden-Rule write guards spread across three surfaces.** Forbidden-subcategory, pre-move
   auto-creation, path-boundary and duplicate-checksum logic live in `web-server.ts` (`:586`,
   `:1262`, `:1277`), `mcp-server.ts` (`:236`, `:264`) and `triage-scan.ts` (`:301`, `:382`). A Go
   port that centralises them differently risks silently archiving into banned taxonomy branches.
4. **Ollama contracts.** `format:'json'`, `think:false`, `num_ctx:16384`, `num_predict:4096`, the
   `done_reason=='length'` truncation check and the down-vs-bad-JSON error distinction are all
   load-bearing (`ollama-client.ts:20`, `:103`–`:124`, `:138`–`:154`;
   `classify-document.ts:175`). A hand-rolled Go client must preserve them exactly.
5. **Concurrency/serialisation.** Three locks interact: the server `.server.lock`
   (`web-server.ts:1541`), the cross-process `.scan.lock` (`scan-lock.ts:15`, `:35`), and the
   in-memory `isAutoScanning`/abort flags (`web-server.ts:84`, `:1397`, `:1434`), plus Windows-only
   port takeover (`pid-lock.ts:41`–`:71`). Getting the Go equivalents wrong reintroduces the
   concurrent-scan `UNIQUE constraint failed: documents.checksum` failure documented in
   `triage-scan.ts:373`–`:384`.
