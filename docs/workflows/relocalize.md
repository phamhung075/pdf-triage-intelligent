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

The modal exposes two dropdowns with **generic, taxonomy-wide reason families** (plus a free-text
"AI Correction Feedback Note"):

- **Why is the Category / Location wrong?** — covers every top-level category (`bank`, tax/gov,
  `bulletin_salaire`, `health`, `insurance`, `identity`, `housing`, `invoices` /
  `factures_clients`, `contracts`, `education`, `recruitment`, `correspondence`,
  `technical` / `reports`) plus the root causes that cut across all of them: issuer-vs-transaction
  confusion (Golden Rule #6), OCR misreads on scanned documents, merged multi-document PDFs, and
  non-FR/EN language. Also includes "Category is correct — only the subcategory / location is
  wrong" for the common case where only the subcategory needs fixing.
- **Why is the Subcategory wrong?** — covers generic fallbacks (`general` / `other` / `divers`),
  wrong or misspelled organization names, entities missing from the dictionary (need creation),
  too-generic slugs, wrong document-type subcategory, filename-echoed slugs, and date / random
  numbers inside the slug.

When a reason is selected **and** the user has moved the target category / subcategory away from the
document's current values, the combined `reason` string also carries a `Target: <cat>/<sub>` suffix
so the AI feedback (`previousError`, Golden Rule #18) states the intended result — never echoing the
wrong current values back at Qwen. A `__CUSTOM__` selection focuses the free-text note so a typed
reason is never silently dropped.

The reasons are concatenated (plus the free-text AI Feedback Note) into a single `reason` string
sent to `POST /api/documents/:id/relocalize`. UI code lives in `public/index.html` (the dropdowns)
and `public/ts/ModalsManager.ts` (`combineRelocalizeReasons()`).

## How a decision teaches future runs (feedback-teaches-AI loop)

Every move that records a `manual_decisions` entry (see below) is ALSO injected into the AI's
**STEP 0 private priority block** on future classifications, so a correction is not wasted on the
one document being moved:

1. `recordManualDecision()` (`src/infrastructure/manual-decisions-store.ts`) auto-derives conservative
   match keywords from the moved document's original filename + title via `deriveRuleKeywords()`
   (`src/domain/decision-rule.ts`): filename codes / scanner prefixes first, then title tokens, with a
   stopword list that filters generic document-type words (`releve`, `facture`, months, years…). A
   decision with no distinctive token is still registered and visible in the tab, but stays inactive
   until the user edits in keywords.
2. `getPromptPersonalization()` (`src/infrastructure/prompt-personalization-store.ts`) merges every
   **enabled** decision (newest 25) into the `priority_rules` it returns — after the hand-curated
   `.prompts.private.json` rules, so deliberate curation outranks an auto-derived rule. Both the
   Qwen prompt (`{{USER_PRIORITY_RULES}}`) and the deterministic `ruleBasedClassify()` fallback
   (`matchPriorityRules`) see the same rules, keeping the two paths aligned (Golden Rule #6).
3. The **Settings → Human Decisions** tab (`🧠 Human Decisions & AI Feedback`, third tab of ⚙️
   System Config) lists the whole audit log: recheck each decision (target, reason, text snippet),
   toggle it on/off, edit its target category/subcategory/reason/keywords, delete one, or delete all.
   Mutations go to `PUT/DELETE /api/manual-decisions[/:id]` and take effect on the NEXT
   classification — no scan or restart required. Disabled/deleted decisions stop teaching
   immediately.

Legacy `manual_decisions` rows (saved before keyword derivation existed) stay active and derive
their keywords lazily from the stored filename/title. The log itself lives in the SQLite
`manual_decisions` table + `manual_decisions.json` mirror (both gitignored, under `DATA_DIR`).

## Rules

- Never accept `general`/`other`/`divers`/year-string as `subcategory`. UI should block submit; server should defend.
- Always update `categories.json` **before** moving.
- Always emit `CATEGORIES_UPDATED` when the taxonomy changed, in addition to `REGISTRY_UPDATED`.

## Owners

Server-side: [pipeline-engineer](../agents/pipeline-engineer.md).
Modal + UX: [ui-frontend](../agents/ui-frontend.md).
Prompt / feedback wiring: [classification-expert](../agents/classification-expert.md).
