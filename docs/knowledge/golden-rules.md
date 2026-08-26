# 🛑 Golden Rules — Non-Negotiable

Every agent MUST obey. Violating any of these means the change is rejected.

Source of truth: `AGENT_REQUIREMENTS.md` and `AGENTS.md` at the project root. These docs summarize and cross-link.

## 0. Think First

Read the code, trace imports, verify schemas BEFORE editing. No guessing paths, parameters, or field names.

## 1. Scan scope

Scan **ONLY** inside `CONFIG.INPUT_DIR` (`__raws`). Never walk parents, siblings, or the whole disk. `__archive` is only read by Repair.

## 2. Server control

**NEVER** run `npm run dev` yourself. Always instruct the user to run/restart it in their own terminal. If a stale process (e.g. from a different worktree) still holds the port, the dev server now auto-kills it and retries once — see [Server startup and port takeover](./architecture.md#server-startup-and-port-takeover) — this doesn't change who runs the command.

## 3. No-text guard

If a PDF yields `< 10` clean characters, BLOCK it: no DB row, no move, keep it in `__raws`, emit `FILE_FAILED` SSE with the exact block message.

## 4. Strict no-subcategory fail guard

If AI resolves to an empty / `general` / `other` / `divers` / year-string subcategory, BLOCK the file. It stays in `__raws`, no DB row, no move. See [classification-flow](../workflows/classification-flow.md).

## 5. Pre-move dynamic auto-create

BEFORE moving a file, the missing category or subcategory MUST be registered in the taxonomy (idempotent). Never construct folders for a slug the taxonomy doesn't know yet.

The write target is **`.categories.private.json`, never the committed `categories.json`** — see `saveCategoriesConfig` in [`src/infrastructure/categories-store.ts`](../../src/infrastructure/categories-store.ts), which diffs the merged config against the public file and persists only the difference to the private overlay. `categories.json` stays a generic, shareable starter taxonomy; `.categories.private.json` is gitignored and accumulates the real subcategories derived from your own documents. Reads always see the two merged, so "is this slug in the taxonomy?" means the merged view, not the committed file alone.

## 6. Deep semantic reading over keywords

The Ollama prompt and the fallback classifier MUST audit issuer, header, and legal purpose. Never classify off a lone keyword from a transaction row. Bank statements are the archetypal trap (`SFR` / `PayPal` appearing inside a Crédit Mutuel statement).

## 7. Company-level separation

Never lump. `banque` is invalid; use `credit_mutuel`, `societe_generale`, `bnp_paribas`, `boursobank`, `lcl`, `la_banque_postale`. Same rule for employers, insurers, health institutions, schools, vendors.

## 8. Canonical path shape

With subcategory: `__archive/<cat>/<sub…>/<YYYY>/<filename>.pdf`
Without: `__archive/<cat>/<YYYY>/<filename>.pdf`
Subcategory may be multi-level (`<school_slug>/bachelor`).

## 9. Sequential non-blocking scan

Files are processed **one by one**. Yield to the event loop between files: `await new Promise(r => setTimeout(r, 50))`. Never `Promise.all` the pipeline.

## 10. Live SSE on every mutation

Every scan / relocalize / edit / repair / clear / auto-watcher tick / category change MUST broadcast an SSE event (`REGISTRY_UPDATED`, `FILE_COMPLETED`, `SCAN_COMPLETED`, `CATEGORIES_UPDATED`, etc.). See [sse-broadcast](../workflows/sse-broadcast.md).

## 11. Markdown representation

Every classified doc stores a `markdown_content` field — a clean structured Markdown reconstruction produced by Qwen 3.5. The UI renders it in the `📝 Document Markdown (.md)` box on the card.

## 12. Executive summary contract

3–5 searchable sentences capturing: issuing organization, key identifiers / ref #, financial amounts / dates, and core purpose. Written to `summary`, indexed in FTS5.

## 13. Toast notifications only

No `alert()`. Use the Toast service (`Toast.success/info/warning/error`).

## 14. Only Qwen 3.5

`CONFIG.OLLAMA_MODEL = 'qwen3.5:9b'`. Legacy models (`qwen2.5:7b`, `deepseek-r1:8b`) are purged; do not reintroduce.

## 15. Clear Registry semantics

`DELETE /api/documents` → move every physical file in `__archive` back to `__raws`, clean empty folders, purge SQLite. See [clear-registry](../workflows/clear-registry.md).

## 16. Repair Registry semantics

Fixes are strictly: ghost purge → re-classify generic subcategories → relocalize to canonical → move-back-to-raws if unrecoverable. Never delete a file — always move-back. See [repair-registry](../workflows/repair-registry.md).

## 17. Auto-watcher cadence

The web server ticks every 10 s; if `__raws` has PDFs and no scan is currently running, kick one off and broadcast progress. Guarded by an `isAutoScanning` flag.

## 18. Feedback-teaches-AI

When a user relocalizes via the modal with an explicit reason (`Why Category Wrong?` / `Why Subcategory Wrong?`), that reason is forwarded as `previousError` to `classifyPDFText` so Qwen retries with the correction. Do not silently swallow the reason.

## 19. Never invent field names

Zod schemas in `src/domain/document.schema.ts` are the contract. All AI JSON output MUST validate via `DocumentMetadataSchema`. Both `categorie` (French) and `subcategorie` are the canonical keys in the AI payload; DB columns are `category`/`subcategory` (English).

## 20. Determinism where it counts

- `temperature: 0.1` for Ollama classification.
- SHA-256 checksum is the dedupe key (`documents.checksum UNIQUE`).
- Year comes from doc date if present, else current year.
