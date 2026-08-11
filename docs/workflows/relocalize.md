# 📍 Relocalize & Re-classify

Entry: `reclassifyAndRelocalizeDocument(id, explicitCategory?, explicitSubcategory?, userFeedbackReason?)` in `src/application/relocalize-document.ts`. HTTP: `POST /api/documents/:id/relocalize`.

## Two modes

### Mode A — user chose explicit target from modal

The Relocalize modal supplies `category` + `subcategory` + optional structured `reason`.

1. Load doc; find file on disk. If missing → purge ghost row and return `{ success: false, staleCleaned: true }`.
2. Extract text as reference (fall back to stored `raw_text` if extraction is short).
3. Normalize `newCategory` / `newSubcategory` (lowercase, trimmed).
4. Auto-create in `categories.json` if either slug is missing (idempotent).
5. `relocalizeFileIfNeeded(actualPath, newCategory, newSubcategory, doc.date)`.
6. `updateDocumentRecord(id, { …, new_path, status: 'MOVED' })`.
7. `syncJSONRegistry()`.
8. Return `{ success: true, message, document }`.
9. Web layer broadcasts `REGISTRY_UPDATED` + `CATEGORIES_UPDATED`.

### Mode B — AI re-analysis (with feedback)

No explicit category. The `reason` (if any) becomes `previousError` in the Ollama call — the feedback-teaches-AI loop (Golden Rule #18).

1. Load doc, find file, extract text (same fallbacks as Mode A).
2. `classifyPDFText(textToAnalyze, filename, reason)`.
3. Adopt AI's `categorie`, `subcategorie`, `titre`, `date`, `summary`, `markdown_content` (with fallbacks to existing values).
4. `relocalizeFileIfNeeded` + `updateDocumentRecord` + `syncJSONRegistry`.

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
