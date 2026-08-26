# 🔄 Triage Pipeline

Entry: `runTriageScan(onProgress?)` in `src/application/triage-scan.ts`.

## Trigger points

- `npm run scan` (one-shot).
- `POST /api/triage/scan` (manual button in UI).
- 10 s auto-watcher tick when `__raws` has PDFs and `isAutoScanning === false`.

## Steps per file (strictly sequential)

Before the loop starts, `pruneBlockedFiles(pdfFilePaths)` removes any `blocked_files` row whose path is no longer present in `__raws`.

For each file found by `getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR)` (PDFs **and** photos — `SUPPORTED_EXTENSIONS` in `pdf-scanner.ts` includes `.png/.jpg/.jpeg/.webp/.bmp/.tiff`):

1. **Skip-cache check**: `fs.statSync(originalPath)`, then `getBlockedFile(originalPath)`.
   - Row exists with matching `mtime_ms`/`size` → skip entirely, no extraction, no classification, no new log line. Replay `FILE_FAILED { message: <stored message> }`. Yield 50 ms, `continue`.
   - Row exists but `mtime_ms`/`size` differ (file replaced/edited) → `deleteBlockedFile(originalPath)`, fall through to retry fresh.
   - See [`blocked_files` table](../knowledge/data-model.md) for schema and rationale.
2. **Broadcast `FILE_PROGRESS { stage: 'EXTRACTING_TEXT' }`**.
3. **Photo → PDF (images only)**: if `isImageFile(originalPath)`, `convertImageToPdf(originalPath)` runs the vision pipeline
   (`runOrientStep` → `runCropStep` → `runEnhanceStep` → `runExtractStep`) and returns `{ pdfPath, checksum, rawText }`.
   - `originalPath` and `file` are then **re-pointed at the generated PDF**, so every later step — blocking, dedupe, the DB
     record, the archive move — operates on the artifact that is actually kept. The loop variable is `incomingPath`; this is
     why `originalPath` is a `let`, not the loop binding.
   - The PDF holds the **cropped** page (natural tones); the **enhanced** page is what OCR reads and is never archived.
   - `rawText` comes back in memory so step 4 is skipped for photos. Without this the fresh PDF would be handed to
     `extractPDFContent`, which would find no text layer, rasterize the page and OCR the same document a second time.
   - The source image is **moved to `__raws/.delete_files/img_converted/`**, never deleted, and only after the PDF is
     confirmed on disk. The PDF holds a cropped, JPEG-re-encoded rendition, so a mis-detected crop silently clips the page
     and the untouched original is the only way back. Name collisions get a `_1`, `_2` … suffix rather than overwriting
     (two cameras both emit `IMG_0001.jpg`). `pdf-scanner.ts` skips dot-directories, so nothing parked there is re-triaged
     — and nothing prunes it either, so the folder grows until the user clears it.
   - If conversion throws, a `TRIAGE` warn is logged and the photo falls through to step 4 unchanged — conversion is an
     enhancement, never a gate.
   - See [`convert-image-document.ts`](../../src/application/convert-image-document.ts).

   **Photo bundles.** Before the file walk, `runTriageScan` calls `findImageBundleFolders(INPUT_DIR)`.
   A folder qualifies only when it holds **2+ images and no other kind of file** — a lone photo is
   not a multi-page document, and a folder mixing photos with a PDF is storage the user keeps, not
   a document to fuse. Each qualifying folder becomes one multi-page PDF named after the folder
   (`__raws/contrat-bail/` → `__raws/contrat-bail.pdf`), pages ordered by `sortImagePagesNaturally`
   so `IMG_2` precedes `IMG_10`, with every page's OCR text concatenated (separated by `---`) so the
   classifier reads the whole document at once. Sources move to
   `.delete_files/img_converted/<folder>/`, keeping the pages grouped; the folder is removed only
   once genuinely empty. Bundling is an enhancement, never a gate: on failure the folder is left
   alone and its photos are triaged individually.
4. **`extractPDFContent(originalPath)`** → `{ checksum, raw_text }` — **skipped** when step 3 already produced them.
5. **No-text guard**: if `cleanText.length < 10`:
   - Log `TRIAGE` warn, `upsertBlockedFile({ reason: 'NO_TEXT_EXTRACTED', … })`, emit `FILE_FAILED { message: '❌ Blocked: No text extracted from PDF. Kept in __raws.' }`.
   - Yield 50 ms, `continue`. No DB row, no move. Skipped on future ticks until the file changes (step 1).
6. **Dedupe**: `getDocumentByChecksum(checksum)`. If found:
   - `skippedCount++`, push a `SKIPPED_DUPLICATE` item.
   - Emit `FILE_COMPLETED { stage: 'SKIPPED_DUPLICATE' }`.
   - Yield 50 ms, `continue`.
7. **Broadcast `FILE_PROGRESS { stage: 'AI_CLASSIFYING' }`**.
8. **`classifyPDFText(raw_text, file)`** → validated `DocumentMetadata` (may auto-create category / subcategory as a side-effect — written to the gitignored `.categories.private.json`, never to the committed `categories.json`; see Golden Rule #5).
9. **Strict no-subcategory fail guard**: if `subcategorie` is empty / `general` / `other` / `divers`:
   - Log warn, `upsertBlockedFile({ reason: 'NO_SUBCATEGORY', … })`, emit `FILE_FAILED`.
   - Yield 50 ms, `continue`. No DB row, no move. Skipped on future ticks until the file changes (step 1).
10. **`generateEmbedding(raw_text)`** — best-effort, returns `[]` on failure.
11. **`insertDocumentRecord(…)`** with `status: 'PENDING'` — enforces UNIQUE(checksum).
12. **Broadcast `FILE_PROGRESS { stage: 'RELOCALIZING' }`**.
13. **`relocalizeFileIfNeeded(originalPath, categorie, subcategorie, date)`** → moves the file to canonical archive path.
14. **`updateDocumentRecord(docId, { new_path: finalTargetPath, status: 'MOVED' })`**.
15. **`processedCount++`**, push a `MOVED` item.
16. **Broadcast `FILE_COMPLETED { stage: 'COMPLETED', …metadata }`**.
17. **Yield 50 ms** (event loop breather).

## Errors per file

Caught in the outer `try/catch`. Emit `FILE_FAILED { message: err.message }`. Yield 50 ms. Continue with the next file.

## After the loop

1. `syncJSONRegistry()` — mirror SQLite to `registry.json`.
2. Broadcast `SCAN_COMPLETED { scannedCount, processedCount, skippedCount }`.
3. Return `{ scannedCount, processedCount, skippedCount, items }`.

## Auto-watcher guard

```ts
let isAutoScanning = false;
setInterval(async () => {
  if (isAutoScanning) return;
  const incoming = getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR);
  if (incoming.length === 0) return;
  isAutoScanning = true;
  try { await runTriageScan(broadcastTriageEvent); }
  finally { isAutoScanning = false; }
}, 10000);
```

The `ignoreDir` parameter to `getPDFsRecursively` ensures `__archive` (if it happens to sit under `__raws`) is never re-scanned.

## Golden rules that apply

Rules #1, #3, #4, #5, #6, #8, #9, #10, #11, #12, #17, #19, #20 all fire in this pipeline.

## Who owns this file

[pipeline-engineer](../agents/pipeline-engineer.md). Cross-cutting changes to classification behavior: also loop in [classification-expert](../agents/classification-expert.md).
