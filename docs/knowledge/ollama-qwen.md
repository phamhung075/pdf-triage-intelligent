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

## Dynamic taxonomy update

Before returning `validated`:
1. Normalize the category slug (`normalizeSlug`).
2. If the category is not in `categories.json` (id or alias), append a new entry with sensible name/description, `saveCategoriesConfig()` (which triggers `CATEGORIES_UPDATED` SSE).
3. Do the same for the subcategory. Strip trailing 4–8 digit chunks that leak dates. If the slug is a year (`/^\d{4}$/`), coerce to `general` (this then trips the strict fail guard elsewhere).

## The system prompt

Encodes the entire [classification-flow](../workflows/classification-flow.md). Any change to the priority order must be mirrored there and in `ruleBasedClassify()` — the two must stay logically aligned.

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
