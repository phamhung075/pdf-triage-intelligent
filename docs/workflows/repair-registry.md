# 🔧 Repair Registry

Entry: `repairRegistry()` in `src/application/repair-registry.ts`. Trigger: `POST /api/registry/repair`.

## Purpose

Reconcile SQLite ↔ disk. Fix generic subcategories. Move irrecoverable files back to `__raws`.

## Steps

1. `reloadConfigFromDisk()` + `ensureDirectoriesExist()`.
2. **Ghost purge pass** over every DB record:
   - Coerce bare-year subcategory to `general`.
   - Locate the physical file via `findActualFileOnDisk(doc)`. If missing → DELETE from `documents` and `documents_fts`. Log `REPAIR`.
3. **Archive walk**: `getAllFilesRecursively(OUTPUT_ROOT_DIR)`.
4. For each file:
   - Re-extract text (`extractPDFContent`).
   - If empty / no readable text → `moveBackToRaws(filePath, checksum)`. `movedToRawsCount++`. Continue.
   - Look up existing DB row by checksum.
     - **If found**:
       - If DB `raw_text` is missing/short/stale vs newly extracted → update, `updatedCount++`.
       - If `subcategory` is generic (`general`/`other`/`divers`) or `category === 'personal'` → run `ruleBasedClassify`. If it yields a specific subcategory, update DB (`updatedCount++`). Otherwise `moveBackToRaws` (`movedToRawsCount++`), continue.
       - `relocalizeFileIfNeeded(filePath, cat, sub, date)`. If moved, `relocalizedCount++`. Update `new_path` / `status = MOVED`.
     - **If not found**:
       - Path hint: `<pathCat>/<pathSub>` from the file's relative path.
       - `classifyPDFText(raw_text, file)` (full Ollama call).
       - Strict fail guard: if generic subcategory → `moveBackToRaws`, continue.
       - `relocalizeFileIfNeeded`. Try `insertDocumentRecord`. On UNIQUE violation, update the existing row instead.
       - `repairedCount++`.
5. `syncJSONRegistry()`.
6. Return `{ scannedCount, repairedCount, updatedCount, relocalizedCount, movedToRawsCount }`.

## Invariants

- Never delete a physical PDF. Move-back only.
- Never leave a doc with a generic subcategory in the archive. Move-back or re-classify.
- Every mutation increments the right counter — the UI displays these totals in the Repair completion toast.

## SSE

Repair itself doesn't push per-file events currently; only the final response returns counts. `POST /api/documents/:id/relocalize` (and other mutations triggered downstream) do broadcast normally.

## Golden rules applied

#4, #5, #6, #8, #16.

## Owner

[pipeline-engineer](../agents/pipeline-engineer.md) with [classification-expert](../agents/classification-expert.md) review whenever the reclassification branch changes.
