# 🧠 Ollama + Qwen 3.5 Contract

## Model matrix

| Purpose        | Model                   | Env override        | Where               |
| -------------- | ----------------------- | ------------------- | ------------------- |
| Classification | `qwen3.5:9b`            | `OLLAMA_MODEL`      | `CONFIG.OLLAMA_MODEL` |
| Embeddings     | `nomic-embed-text`      | `OLLAMA_EMBED_MODEL` | `CONFIG.OLLAMA_EMBED_MODEL` |
| Host           | `http://127.0.0.1:11434` | `OLLAMA_HOST`      | `CONFIG.OLLAMA_HOST` |

Only Qwen 3.5 is supported. Legacy models (`qwen2.5:7b`, `deepseek-r1:8b`) were purged; do not reintroduce.

## Ensuring the model is present

`ensureOllamaModel()` in `src/infrastructure/ollama-client.ts`:

1. `ollama.list()` — check if a model whose name starts with or includes `qwen3.5:9b` is loaded.
2. If not, `ollama.pull()` it.
3. If the whole call fails, auto-spawn `ollama serve` via `child_process.exec` (Windows), wait 2 s, retry list.

## Classify call parameters

```ts
await ollama.generate({
  model: CONFIG.OLLAMA_MODEL,
  system: systemPrompt,   // massive taxonomy + 13-step flow
  prompt: userPrompt,     // filename + text snippet + optional previousError
  format: 'json',
  options: { temperature: 0.1 }
});
```

Text is truncated to 4000 chars before sending (`textSnippet`).

## Step C — chunked Markdown conversion

`markdown_content` is **not** produced by the classification call. `convertRawTextToZeroLossMarkdown()`
(`src/application/classify-document.ts`) runs its own pass before Step D:

1. `chunkText(rawText, 1400)` splits the raw text on line boundaries into ~1400-char chunks.
2. Each chunk goes to `requestTextChatCompletion` — **not** `requestClassificationCompletion`.
   The latter forces `format:'json'` grammar-constrained decoding, which garbles free-form Markdown
   and silently degraded nearly every chunk to the raw-text fallback.
3. Chunks are converted independently, then joined with a blank line.

`prompts/micro_prompt_markdown.md` is the chunk prompt. Its rule 1 is the contract the rest of this
section exists to protect: **zero content skipping**.

### Continuation context

A chunk boundary can land in the middle of a table. `detectOpenTableTail()` inspects a chunk's
output: if its last non-blank line is a table data row with a header + separator above it *in the
same chunk*, that header/separator is threaded into the next chunk's prompt as
`MarkdownContinuationContext` so the model continues the same table instead of opening a new one.

Its limit is worth knowing: detection needs the separator row to be **in the same chunk**. When the
split lands before the model has emitted a separator, the next chunk starts with a bare data row and
the output contains a headerless "orphan" table block. Measured on the live registry, 24.2% of
archived documents carry at least one malformed table block (ragged rows, a table restarted
mid-block, or an orphan) — dense grid layouts like payslips are the worst affected.

### Two failure modes, both fall back to raw text

Neither is an error to the caller — Step C always returns *something*, so callers cannot distinguish
a fully converted document from a partly raw one except through the log:

| Situation | Behaviour |
| --- | --- |
| Model returns empty / ≤10 chars | The **raw chunk** is kept verbatim; counted as a fallback. |
| Model call throws (timeout, socket reset, model unloaded) | The **raw chunk** is kept verbatim; counted as a fallback. |

Both log at `WARN` with `chunkIndex`/`totalChunks`, and a per-document summary line reports
`successCount`/`fallbackCount`. A document whose markdown is much shorter than its `raw_text` means
chunks were lost, not merely unconverted — grep `[STEP C]` for that document.

> Historical note: the throw branch used to increment the fallback counter *without* keeping the
> chunk, so a failed chunk was deleted outright — a 4-chunk document came back as chunks 1, 3, 4
> with no error surfaced anywhere. Six archived France Travail / Pôle Emploi documents still carry
> `markdown_content` at 6–14% of their `raw_text` from that period and need re-processing.

## JSON parsing

`cleanAndParseJSON()`:
- Strip ```` ```json ``` ```` fences.
- Slice from first `{` to last `}`.
- Remove trailing commas.
- `JSON.parse`.
- Validate with `DocumentMetadataSchema.parse` (Zod).

If any of these fail → fall back to `ruleBasedClassify()` and construct a `DocumentMetadata` from its output.

## Refinement layer

After parse, the code corrects:
- If `categorie` is `personal`/`other` or `subcategorie` is `general`, re-run the rule-based classifier and merge in.
- If AI returned `correspondence` but the filename smells like tax, prefer the rule-based `administrative`.
- Defense-in-depth date guard: if `date` is in the future relative to today and looks like an OCR two-digit-year misread that contradicts the year stated in `titre` (e.g. "30/11/26" misread from "30/11/25"), `reconcileDocumentDate()` (`src/domain/classification.ts`) corrects `date` back to the titre's year and logs a warning. This backstops the prompt-level guard below — the future-dated value would otherwise sort a document as newer than it is anywhere `date` drives ordering (e.g. `ai-chat-assistant.ts`'s "N last pay slips" queries).

## Dynamic taxonomy update

Before returning `validated`:
1. Normalize the category slug (`normalizeSlug`).
2. If the category is not in the merged taxonomy (id or alias), append a new entry with sensible name/description, `saveCategoriesConfig()` (which triggers `CATEGORIES_UPDATED` SSE). The merged taxonomy is `categories.json` + `.categories.private.json`; the write lands in the **private** file only (Golden Rule #5).
3. Do the same for the subcategory. Strip trailing 4–8 digit chunks that leak dates. If the slug is a year (`/^\d{4}$/`), coerce to `general` (this then trips the strict fail guard elsewhere).

## The system prompt

Encodes the entire [classification-flow](../workflows/classification-flow.md). Any change to the priority order must be mirrored there and in `ruleBasedClassify()` — the two must stay logically aligned.

`buildClassificationPrompt()` (`src/domain/prompt.ts`) also takes a `now: Date` (default `new Date()`) and injects `{{CURRENT_DATE}}` — formatted by `formatLocalDate()` using local calendar fields, not `toISOString()`, to avoid a UTC-shift date-off-by-one for timezones ahead of UTC — into `prompts/formatting_rules.md`. This grounds the model in today's date so it can reject an ambiguous two-digit-year date that would land in the future or contradict the document's stated period, and reminds it not to conflate the document's own issuance date (`date`) with a validity/expiration date (`expiry_date`).

## Personal prompt overlay

The committed `prompts/` templates are generic and publishable. Personal classification
signals (real employers, bank product/filename codes, clinics, schools, scanner prefixes)
come from the gitignored `.prompts.private.json` and are injected into two placeholders at
build time — `{{USER_PRIORITY_RULES}}` (rendered as a STEP 0 ahead of the generic STEP 1 in
`prompts/classification_rules.md`) and `{{USER_KNOWN_ENTITIES}}` (Step A entity extraction
in `prompts/micro_prompt_entity.md`). Both render to the empty string when the file is
absent.

The same overlay also drives `ruleBasedClassify()` through `matchPriorityRules()`, so the prompt
and the deterministic fallback stay aligned on user-specific signals instead of one of them
silently keeping literals the other dropped. See
[taxonomy](taxonomy.md#personal-prompt-overlay) for the shape, the matching rules, and the
Golden Rule #6 exception.

## `previousError` retry

When the user relocalizes a doc via the modal with an explicit reason, that string is passed as the third argument to `classifyPDFText`. The prompt gets an appended block:

> ⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):
> The previous classification attempt for this document encountered an error: "<reason>".
> Please carefully analyze the document text and fix this issue…

This is the feedback-teaches-AI loop (Golden Rule #18).

## Embeddings

`generateEmbedding(text)` calls `ollama.embeddings({ model: nomic-embed-text, prompt: text.substring(0, 1000) })`. On any error → `[]`. Stored as JSON in `documents.embedding`. Currently not used for search (search is FTS5 keyword-only), but reserved for future hybrid mode.

## Health endpoints

- `GET /api/ollama/status` — `{ online, model, host, modelsCount, modelExists }`.
- `POST /api/ollama/start` — spawns `ollama serve`.
- UI: status badge in header + `▶️ Start Ollama` button.

Own agent: [ollama-ops](../agents/ollama-ops.md).
