# 📁 Canonical Paths

## Formula

```
<OUTPUT_ROOT_DIR> / <category> / <subcategory…> / <YYYY> / <filename>.pdf
```

- With subcategory: `__archive/<cat>/<sub>/<YYYY>/<file>.pdf`
- With nested subcategory: `__archive/<cat>/<sub1>/<sub2>/<YYYY>/<file>.pdf`
- Without a specific subcategory: **not allowed** for a completed doc (Golden Rule #4). Repair will move the file back to `__raws`.

Implemented in `computeCanonicalPath()` (`src/domain/taxonomy.ts`).

## Year resolution

1. If `dateStr` contains a `20\d{2}` match, use that year.
2. Otherwise, current year at compute time.

## Category / subcategory sanitation

- `toLowerCase().trim()`.
- If subcategory is a bare year (`isYearString`), coerce to `general` (which will then trip the fail guard for new docs; used mostly by legacy migration paths).
- Subcategory split on `/` and `\` to support multi-level nesting (`ecole_x/bachelor` → `ecole_x`, `bachelor`).

## Move semantics — `relocalizeFileIfNeeded()`

1. Compute canonical target.
2. If normalized target == normalized source → no-op.
3. Ensure target dir exists (recursive mkdir).
4. If target exists and is not the current file → append `_${Date.now()}` before the extension (collision-safe rename).
5. `fs.renameSync` from source to target.
6. Log `RELOCALIZE` event.
7. Clean up: if old parent dir is empty, `rmdir`. Same for grandparent. Never recurse further up.
8. Return `{ newPath, moved }`.

## Move-back-to-raws — `moveBackToRaws()`

Used by Repair when a doc has no readable text or no specific subcategory, and by Clear Registry.

1. Target = `INPUT_DIR / filename`.
2. Collision-safe rename (append `_${Date.now()}`).
3. If a `checksum` is passed, DELETE the SQLite row (and FTS row).
4. Clean up empty parent / grandparent dirs.
5. Return the final `__raws` path.

## Finding a file on disk — `findActualFileOnDisk(doc)`

Ordered probing:
1. `doc.new_path` if it exists.
2. `doc.original_path` if it exists.
3. `INPUT_DIR / original_filename` if it exists.
4. Recursively walk `OUTPUT_ROOT_DIR`, match by case-insensitive basename.
5. `null` if not found → caller purges the ghost record.

## Rules to keep straight

- Never write outside `OUTPUT_ROOT_DIR` (`__archive`) or `INPUT_DIR` (`__raws`).
- Never delete a PDF. All destructive-looking flows either rename (relocalize / move-back) or purge only the DB row.
- Never leave a category or subcategory folder that has no `<YYYY>` grandchild — always clean empty dirs after a move.
- The `<YYYY>` bucket is mandatory: docs without a parseable year still get bucketed under the current year.
