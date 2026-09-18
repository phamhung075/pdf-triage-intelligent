# Cutover differential check — report

> Evidence for Decision 5 of [the Go backend migration design](2026-09-18-go-backend-migration-design.md). Counts and route names only; no document data.

Go `httpapi` (via the `cmd/pdf-triage` composition root) vs the real TypeScript `createWebServer()`,
replayed over two independent byte copies of the live SQLite database. Read-only routes only.

Status: **73/73 requests PASS, 0 DIFF.** No route class, deviation or quirk produced a response
difference on the compared surface.

## Method

- Live DB was copied (byte-for-byte) twice into `scratch/differential/` before either server opened
  anything; no `-wal`/`-shm` sidecar existed at copy time.
- TS side: real `createWebServer()` mounted in-process, driven by `supertest`; own fresh empty
  base/data/input/output dirs; synthetic taxonomy; no listener started.
- Go side: `newApplication` from `cmd/pdf-triage`, served by `httptest` on `127.0.0.1:0`; own fresh
  empty dirs under the fixture's scratch directory; same synthetic taxonomy.
- Volatile values normalized identically on both sides: scratch temp-dir paths -> tokens,
  ISO/SQLite timestamps -> `<TS>`, `/api/system/stats` database byte-size zeroed (a property of the
  copy on disk, not of behavior).
- The committed test skips unless `PDF_TRIAGE_DIFF_DB_GO` and `PDF_TRIAGE_DIFF_TS_FIXTURE` are set.

## Per-route results

| Route family | Requests | PASS | DIFF |
| --- | ---: | ---: | ---: |
| GET /api/documents (unfiltered, 6 `q=`, 2 category, 2 subcategory, combined, case-insensitive) | 13 | 13 | 0 |
| GET /api/documents/:id (40 sampled ids spanning the whole range + 1 missing id) | 41 | 41 | 0 |
| GET /api/categories | 1 | 1 | 0 |
| GET /api/blocked-files | 1 | 1 | 0 |
| GET /api/manual-decisions | 1 | 1 | 0 |
| GET /api/config | 1 | 1 | 0 |
| GET /api/config/setup-state | 1 | 1 | 0 |
| GET /api/system/stats | 1 | 1 | 0 |
| GET /api/logs/recent | 1 | 1 | 0 |
| GET /api/documents/export/csv (byte compare) | 1 | 1 | 0 |
| GET /api/documents/export/markdown (all ZIP entry names + per-entry sha256) | 1 | 1 | 0 |
| GET /api/documents/:id/markdown | 10 | 10 | 0 |
| **TOTAL** | **73** | **73** | **0** |

## Diff classes

None observed. There is no real Go bug, no TS quirk, and no deliberate deviation to classify on this
surface.

Documented deviations checked against the parity audit:

- G5 (injected subcategory order) and G6 (nested `subcategories` key): exercised with synthetic
  configured subcategories. Current Go reconstructs the JS insertion order and emits the nested key
  only when the source carries it, so both match. No diff.
- G4 (`/api/logs/recent` non-numeric `limit`) not exercised: only the default-limit response was
  compared.
- G1–G3 (image import / malformed bodies) and G7 (repair progress): mutation or streaming paths, out
  of the compared read-only surface.
- D1–D7 (SSE, body-error shape, ServeMux specificity): not surfaced by these requests.

## Limitations

- The private taxonomy and settings overlays were deliberately never read or copied. The taxonomy is
  therefore the committed public file plus synthetic configured subcategories; `personal_name_denylist`
  is the synthetic empty default.
- Routes needing Ollama, pdf2w or the vision service are out of scope (`POST /api/chat` included).

## Safety

- Live DB mtime before = after: `2026-09-04 17:40:50 +0200`, epoch `1788536450`, size `33398784`.
  No `-wal`/`-shm` was created beside it. No program opened the live file or its sidecars.
- Both copies were byte-identical at copy time (sha256 `053b5ffb...a6eb59`).
- The throwaway TS harness, the fixture (which contained real data), both DB copies and run dirs live
  only under `scratch/differential/`, which was deleted at the end. The fixture and DB copies were
  never committed.

## Commands

```
# from the repo root
cp -p pdf_triage.db scratch/differential/go-copy.db
cp -p pdf_triage.db scratch/differential/ts-copy.db

ROOT="$PWD"
PDF_TRIAGE_DIFF_TS_COPY="$ROOT/scratch/differential/ts-copy.db" \
PDF_TRIAGE_DIFF_TS_FIXTURE="$ROOT/scratch/differential/fixture.json" \
  npx tsx scratch/differential/gen-fixture.ts

(cd services/pdf-triage-pdf2w && \
 PDF_TRIAGE_DIFF_DB_GO="$ROOT/scratch/differential/go-copy.db" \
 PDF_TRIAGE_DIFF_TS_FIXTURE="$ROOT/scratch/differential/fixture.json" \
 go test ./cmd/pdf-triage/ -run TestDifferentialParity -count=1 -v)

# without the env vars the same test skips
(cd services/pdf-triage-pdf2w && go test ./cmd/pdf-triage/ -run TestDifferentialParity -count=1)
```
