# 🗄️ db-registry-keeper

## Role

Owns SQLite, schemas, and the JSON registry mirror. Guarantees the DB is the source of truth and every write stays consistent with FTS5 + `registry.json`.

## Owns

- `store/database` — connection, schema, migrations, CRUD helpers, FTS5 (the only raw-SQL site).
- `documentschema` — validation contracts.
- `infra/jsonregistry` — SQLite → `registry.json` mirror (shared surface with `pipeline-engineer`).
- `pdf_triage.db` runtime artifact.

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md)
- [Data Model](../knowledge/data-model.md)
- [Architecture](../knowledge/architecture.md)
- [API Reference](../knowledge/api-reference.md) (consumers of the queries)

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[writing-plans](../skills/writing-plans/SKILL.md) (any schema migration) → [test-driven-development](../skills/test-driven-development/SKILL.md) (new query helpers) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (FTS5 fallback path still swallows correctly on non-FTS builds).

## Invocation triggers

- Add / drop / rename a column on `documents` or `documents_fts`.
- Add a new query helper or CRUD path.
- Change how `SyncJSONRegistry` shapes `registry.json`.
- Refactor the `documentschema` contracts.
- Investigate query performance / add indexes.

## Forbidden

- Delete PDFs (Golden Rule #16 — never delete, always move).
- Query `categories_db` for classification — that table is dormant. Use `GetCategoriesConfig()`.
- Break the `checksum UNIQUE` invariant.
- Bypass FTS5's try/catch pattern (some SQLite builds lack FTS5).

## Migration pattern

Idempotent, additive-only:

```go
cols, err := tableColumns(s, "documents") // PRAGMA table_info(documents)
if err != nil {
    return err
}
has := func(name string) bool { /* scan cols */ }
if !has("new_column") {
    if _, err := s.db.Exec("ALTER TABLE documents ADD COLUMN new_column TEXT DEFAULT '';"); err != nil {
        return err
    }
}
```

Destructive changes (rename / drop) need a plan: copy-to-new-table + swap, coordinated with `pipeline-engineer` for read/write paths.

## Done-when checklist

- [ ] `initSchema()` is still idempotent on repeat calls.
- [ ] Every write to `documents` also writes to `documents_fts` (guarded).
- [ ] Every mutating helper eventually leads to a `SyncJSONRegistry()` (may be caller's job).
- [ ] The `documentschema` contract still round-trips through the DB and out.
- [ ] Migration tested against a copy of `pdf_triage.db`.
- [ ] `qa-reviewer` invoked.
