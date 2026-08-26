# 🗄️ Data Model

Three storage surfaces, one truth (SQLite), two mirrors (JSON registry, categories.json).

## `documents` table

Primary record. Created in `src/infrastructure/db/database.ts` `initSchema()`.

| Column              | Type     | Notes                                             |
| ------------------- | -------- | ------------------------------------------------- |
| `id`                | INTEGER  | PK autoincrement                                  |
| `checksum`          | TEXT     | SHA-256 of file bytes. UNIQUE — dedupe key        |
| `title`             | TEXT     | AI-corrected titre                                |
| `registre`          | TEXT     | Reference / registry number                       |
| `date`              | TEXT     | `YYYY-MM-DD`                                      |
| `category`          | TEXT     | Slug — must exist in `categories.json`            |
| `subcategory`       | TEXT     | Slug — must exist in `categories.json`, never `general`/`other`/`divers`/year for a completed doc |
| `summary`           | TEXT     | 3–5 sentence Executive Summary                    |
| `tags`              | TEXT     | JSON-encoded string[]                             |
| `raw_text`          | TEXT     | Full extracted text (indexed in FTS5)             |
| `markdown_content`  | TEXT     | Qwen 3.5 structured `.md` reconstruction. Added via ALTER TABLE migration if missing |
| `original_filename` | TEXT     | Basename at scan time                             |
| `original_path`     | TEXT     | Full path in `__raws` at scan time                |
| `new_path`          | TEXT     | Canonical path after move                         |
| `embedding`         | TEXT     | JSON-encoded number[] from `nomic-embed-text`     |
| `status`            | TEXT     | `PENDING` \| `MOVED`                              |
| `created_at`        | DATETIME | ISO                                               |
| `updated_at`        | DATETIME | ISO                                               |

### Migrations

`initSchema()` runs idempotently on every `getDb()`. Uses `PRAGMA table_info(documents)` to check for `subcategory` and `markdown_content` columns and `ALTER TABLE` if missing.

## `documents_fts` (FTS5, optional)

Created with a `try/catch` — some SQLite builds lack FTS5.

Columns (all TEXT except `doc_id UNINDEXED`):
`doc_id, title, original_filename, original_path, new_path, registre, summary, category, subcategory, tags, raw_text`

Rewritten on every insert / update / relocalize.

### Schema drift is detected and repaired

`CREATE VIRTUAL TABLE IF NOT EXISTS` is a **no-op against an existing table**, so it does not
migrate one whose columns have drifted. That bit hard: the on-disk table kept its original 7
columns while the INSERTs grew to 11, every insert failed at prepare, and the failure landed in an
empty `catch` — the index sat at **0 rows against a full corpus** for the life of the database, and
Golden Rule #12 (full-text search) was quietly false the whole time.

`initSchema()` now compares `PRAGMA table_info(documents_fts)` against the expected column list. On
a mismatch it logs the drift, drops and recreates the table; and whenever the index is empty while
`documents` is not, it backfills from `documents` in one `INSERT … SELECT`. Both paths are
idempotent, so a healthy database pays only two `COUNT(*)` queries per startup.

The write sites no longer swallow failures either — a genuine breakage warns once per process
(`warnFtsWriteFailure`) instead of vanishing, while a SQLite build that truly lacks FTS5 does not
spam the log.

## `categories_db` table

Present in schema but **not** the taxonomy source of truth. The live taxonomy is `categories.json`. Do not query `categories_db` for classification; treat it as reserved for a future migration.

## `blocked_files` table

Skip-cache for permanently unprocessable files in `__raws`, so `runTriageScan` doesn't re-extract, re-classify, and re-log the same file on every 10 s auto-watcher tick. A file only gets a row here when it never made it to `documents` — no text extracted, or subcategory resolved to `general`/`other`/`divers`/empty.

| Column           | Type     | Notes                                                    |
| ---------------- | -------- | --------------------------------------------------------- |
| `original_path`  | TEXT     | PK — full path in `__raws`                                |
| `filename`       | TEXT     | Basename, for display                                     |
| `reason`         | TEXT     | `NO_TEXT_EXTRACTED` \| `NO_SUBCATEGORY`                    |
| `message`        | TEXT     | User-facing text, replayed verbatim on skip                |
| `mtime_ms`       | REAL     | File mtime at block time — cache key, paired with `size`  |
| `size`           | INTEGER  | File size in bytes — cache key, paired with `mtime_ms`    |
| `blocked_at`     | DATETIME | ISO, set on insert and refreshed on every re-upsert        |

Four helpers in `src/infrastructure/db/database.ts`: `getBlockedFile(originalPath)`, `upsertBlockedFile(entry)` (upsert keyed on `original_path`), `deleteBlockedFile(originalPath)`, `pruneBlockedFiles(existingPaths)` (deletes rows whose path is no longer in `__raws`).

Used by `runTriageScan` — see [Triage Pipeline](../workflows/triage-pipeline.md) for the full skip/retry flow: matching `mtime_ms`+`size` skips re-processing entirely and replays the stored `message`; a mismatch deletes the row and retries fresh; `pruneBlockedFiles` runs once per scan before the per-file loop.

## `categories.json` schema

Validated by `CategoriesConfigSchema` (Zod). Structure:

```jsonc
{
  "categories": [
    {
      "id": "administrative",           // slug
      "name": "Administratif",          // display
      "description": "…",
      "aliases": ["tax", "impot"],      // aliased on classify
      "subcategories": [
        {
          "id": "credit_mutuel",
          "name": "Crédit Mutuel",
          "aliases": ["credit_mutuel"],
          "subcategories": []          // nesting allowed
        }
      ]
    }
  ]
}
```

Subcategories can nest (multi-level). Category-not-found and subcategory-not-found trigger dynamic auto-creation **before** file move (Golden Rule #5).

## `registry.json` (JSON mirror)

Written by `syncJSONRegistry()` after every mutation. Shape:

```jsonc
{
  "updated_at": "2026-07-28T…",
  "total_count": 42,
  "documents": [ { …flattened row… } ]
}
```

Purpose: external consumers, backups, human diff-friendly view. Never used by the app as a read source at runtime.

## AI JSON contract (`DocumentMetadata`)

Emitted by `classifyPDFText()`; validated by `DocumentMetadataSchema` (Zod). Uses French keys `categorie`/`subcategorie`:

```jsonc
{
  "titre": "Bulletin de Salaire — Mai 2024",
  "registre": "N°BS-000123",
  "date": "2024-05-31",
  "categorie": "bulletin_salaire",
  "subcategorie": "acme_corp",
  "summary": "Bulletin de salaire mensuel émis par ACME CORP pour mai 2024, salaire brut 3200€, net 2450€…",
  "tags": ["bulletin_salaire", "acme_corp", "salaire"],
  "markdown_content": "# Bulletin de salaire — Mai 2024\n\n| Champ | Valeur |\n|---|---|\n…",
  "other": {}
}
```

## `settings.json`

Runtime-mutable subset of `CONFIG`, written via `updateConfig()`:

```jsonc
{
  "input_dir": "…",
  "output_root_dir": "…",
  "ollama_model": "qwen3.5:9b",
  "ollama_host": "http://127.0.0.1:11434"
}
```

Reloaded on every scan via `reloadConfigFromDisk()`.
