# 📍 Relocalize & Re-classify

Entry: `reclassifyAndRelocalizeDocument(id, explicitCategory?, explicitSubcategory?, userFeedbackReason?)` in `src/application/relocalize-document.ts`. HTTP: `POST /api/documents/:id/relocalize`.

## Two modes

### Mode A — user chose explicit target from modal

The Relocalize modal supplies `category` + `subcategory` + optional structured `reason`.

1. Load doc; find file on disk. If missing → purge ghost row and return `{ success: false, staleCleaned: true }`.
2. Re-extract text as reference, then pick which text to use (see [Which text a re-analysis uses](#which-text-a-re-analysis-uses)).
3. Normalize `newCategory` / `newSubcategory` (lowercase, trimmed).
4. Auto-create in `categories.json` if either slug is missing (idempotent).
5. `relocalizeFileIfNeeded(actualPath, newCategory, newSubcategory, doc.date)`.
6. `updateDocumentRecord(id, { …, new_path, status: 'MOVED' })`.
7. `syncJSONRegistry()`.
8. Return `{ success: true, message, document }`.
9. Web layer broadcasts `REGISTRY_UPDATED` + `CATEGORIES_UPDATED`.

### Mode B — AI re-analysis (with feedback)

No explicit category. The `reason` (if any) becomes `previousError` in the Ollama call — the feedback-teaches-AI loop (Golden Rule #18).

1. Load doc, find file, extract text (same selection rules as Mode A).
2. `classifyPDFText(textToAnalyze, filename, reason)`.
3. Adopt AI's `categorie`, `subcategorie`, `titre`, `date`, `summary`, `markdown_content` (with fallbacks to existing values).
4. `relocalizeFileIfNeeded` + `updateDocumentRecord` + `syncJSONRegistry`.

## Which text a re-analysis uses

Rescan / Re-analyze re-extracts from scratch rather than reusing the stored text, so it can pick up
a better OCR pass — but it must never pick up a WORSE one. The file's bytes have not changed, so
text produced by a healthy extraction is strictly the better input.

| Fresh extraction | Stored `raw_text` | Used |
| --- | --- | --- |
| > 10 chars, `ocr_degraded: false` | anything | **fresh** (and persisted to `raw_text`) |
| > 10 chars, `ocr_degraded: true` | > 10 chars | **stored** — the downgrade is refused and logged `warn` |
| > 10 chars, `ocr_degraded: true` | empty/short | **fresh** — degraded text still beats no text |
| ≤ 10 chars | anything | **stored** |

When the fresh text is used it is now written back to `raw_text` in the same `updateDocumentRecord`
call. Leaving it behind is what let a record contradict itself: `title`/`date`/`summary`/
`markdown_content` rebuilt from new text sitting beside the old evidence, with nothing in the UI to
show the mismatch.

The `ocr_degraded` flag comes from `extractPDFContent` and is tracked **per page** — a two-page scan
can genuinely come back half PaddleOCR and half Tesseract.

## Structured reasons from the modal

The modal exposes two dropdowns:

- **Why is Category Wrong?** — e.g. `Bank Statement misclassified as Vendor Invoice`, `Tax form misclassified as Courriers`, `Pay Slip misclassified as Invoice`.
- **Why is Subcategory Wrong?** — e.g. `Generic fallback used`, `Wrong Employer / Enterprise name`, `Wrong Bank Society`, `Date numbers inside folder name`.

They are concatenated (plus the free-text AI Feedback Note) into a single `reason` string sent to `POST /api/documents/:id/relocalize`. UI code lives in `public/app.js`.

## Rules

- Never accept `general`/`other`/`divers`/year-string as `subcategory`. UI should block submit; server should defend.
- Always update `categories.json` **before** moving.
- Always emit `CATEGORIES_UPDATED` when the taxonomy changed, in addition to `REGISTRY_UPDATED`.

## Owners

Server-side: [pipeline-engineer](../agents/pipeline-engineer.md).
Modal + UX: [ui-frontend](../agents/ui-frontend.md).
Prompt / feedback wiring: [classification-expert](../agents/classification-expert.md).
