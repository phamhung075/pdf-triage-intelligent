---
name: pdf-triage-extraction
description: Use when changing pdf-triage's PDF/photo text extraction — the pdf2w extraction client, canonical-path resolution, or the pre-registration quality gate.
---

# The extraction chain (post pdf2w swap, 2026-09-18)

A PDF (or a photo-derived, image-only PDF) becomes `ExtractedPDF` through exactly **one** required
HTTP call. There is no fallback chain anymore — see
[`pdf2w-extraction.md`](../../../docs/knowledge/pdf2w-extraction.md) for the full design record.

```
PDF (or photo, after orient → crop → enhance → assemble)
 │  ExtractPDFContent() — infra/pdfextractor
 ▼
infra/pdf2w  POST /convert  ──►  self-hosted markdown-extract-service (pdf2w)
                                     native extraction + Gemini→DeepSeek vision-rescue OCR
 │
 ▼  unreachable / PDF2W_SERVICE_URL unset
throws ──► FILE_FAILED for that document (no in-process fallback left)
```

| Layer | Client | Implementation |
| --- | --- | --- |
| Extraction | [`infra/pdf2w`](../../../services/pdf-triage-pdf2w/infra/pdf2w/) | external, self-hosted `markdown-extract-service` (own repo, `/home/daihu/__projects__/markdown-extract-service`), port 3984, `PDF2W_SERVICE_URL` |
| Canonical path (organize-files, not extraction, but the other half of the same swap) | [`canonicalpath`](../../../services/pdf-triage-pdf2w/canonicalpath/) | in-process Go package, no service and no URL |

The wrapper is `ExtractPDFContent()` in `infra/pdfextractor`; the orchestration entry point is
`cmd/pdf-triage`. `infra/pdf2w` is **required, not optional-with-fallback** — do not add a
`_REQUIRED` toggle or an in-process fallback branch back in;
that architecture was deliberately removed, not merely bypassed. Background and rationale:
[`pdf2w-extraction.md`](../../../docs/knowledge/pdf2w-extraction.md),
[`docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md`](../../../docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md).

## What was removed — do not reintroduce

The Docling quality gate (`docling-quality.ts`, `docling-remote.ts`, `DOCLING_SERVICE_URL`), the
in-repo Dockerized extract microservice (`src/extract-service/`, `pdf-extract-remote.ts`,
`PDF_EXTRACT_SERVICE_*`), and the local OCR engines (PaddleOCR `paddleocr-client.ts`, Tesseract,
`ocr-layout.ts`) are all deleted. There is no `ocr_degraded` signal worth checking anymore —
pdf2w performs its own vision-rescue server-side and reports no per-page engine-degradation back;
the field survives on `ExtractedPDF` for backward compatibility only and is never set.

## The pre-registration quality gate (unchanged by the swap)

[`extractionqualitygate`](../../../services/pdf-triage-pdf2w/extractionqualitygate/) runs in two layers,
regardless of where the text came from:

1. **During Step C**, `AssessChunkMarkdown` / `DescribeTableRepairNote` screen each chunk. A chunk with malformed table rows or an absurd column blow-out is re-converted **once, alone**, with a corrective note — the healthy chunks are left untouched and are not re-rolled.
2. **Before registration** (in `app/triagescan`, after classification), `AssessExtractionQuality` assesses the complete document and throws `ExtractionQualityGateError` — a typed, catchable error mirroring `OllamaUnavailableError`, so the web route, an MCP tool, or an agent can act on the structured `QualityGateReport` instead of parsing log lines.

The origin is doc 5009 (2026-09-03): a table came back with rows outside the GFM pipes, values dropped out entirely, and the pipeline stored it with no error — the integrity audit only sees lines that *start* with `|`, so the malformed rows were invisible.

**Every `QUALITY_GATE` threshold is deliberately conservative and corpus-calibrated** (recent docs 4991–5009: healthy documents pass with margin, the known-bad shapes fail). The gate exists to keep obviously unusable content out of the registry, where it silently corrupts FTS search, summaries and the chat assistant — not to reject documents with cosmetic quirks. Tightening a threshold needs corpus evidence, and loosening one to make a document pass needs a written reason.

## Verifying a change here

Run `make test` (`cd services/pdf-triage-pdf2w && go test ./...`) — the `extractionqualitygate`, `markdowntables`, `pdftext`, `infra/pdfextractor`, `infra/pdf2w` and `canonicalpath` Go tests hold the behaviour. Confirm the change still throws (does not silently no-op) when `PDF2W_SERVICE_URL` is unset or the service is unreachable — that hard-failure behavior is intentional, not a gap to patch over with a fallback. Do not run `make dev` to check — see [pdf-triage-verify](../pdf-triage-verify/SKILL.md).
