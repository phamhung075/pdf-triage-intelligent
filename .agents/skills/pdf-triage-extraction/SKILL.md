---
name: pdf-triage-extraction
description: Use when changing pdf-triage's PDF text extraction — the Docling quality layer, the Dockerized extract microservice, in-process extraction and OCR, or the pre-registration quality gate — and when deciding which of the three extractors a change belongs in.
---

# The extraction chain

A PDF becomes `ExtractedPDF` through one of three extractors, in this order. Each later one is the fallback for the one before it, and they all return the **same** values, so the checksum, the dedupe key, the text cleanup and the `< 10` character guard are identical whichever ran.

```
PDF
 │  DOCLING_SERVICE_URL set + .pdf
 ▼
Docling ──► assessDoclingMarkdown PASS ──► raw_text + docling_markdown   (Step C skipped)
 │  FAIL / service down
 ▼  PDF_EXTRACT_SERVICE_URL set
extract microservice ──► unreachable? WARN + fall through
 │
 ▼  always available
in-process extractPDFContentLocal
```

| Layer | Client | Implementation |
| --- | --- | --- |
| Docling | [`docling-remote.ts`](../../../src/infrastructure/docling-remote.ts) | separate repo, port 3984 — see [`docling-extract-layer.md`](../../../docs/knowledge/docling-extract-layer.md) |
| Microservice | [`pdf-extract-remote.ts`](../../../src/infrastructure/pdf-extract-remote.ts) | [`src/extract-service/`](../../../src/extract-service/), `GET /health` + `POST /extract`, port 3981 |
| In-process | — | [`pdf-extractor.ts`](../../../src/infrastructure/pdf-extractor.ts), the original chain |

The wrapper is `extractPDFContent()` in `pdf-extractor.ts`; the orchestration entry point is `src/index.ts`. The split is **transport-only** — do not fork the extraction logic per path, or the identical-output guarantee breaks. Background and rationale: [`pdf-extract-service.md`](../../../docs/knowledge/pdf-extract-service.md), [`docling-extract-layer.md`](../../../docs/knowledge/docling-extract-layer.md).

## The Docling gate

Docling's Markdown is adopted only if `assessDoclingMarkdown` passes ([`docling-quality.ts`](../../../src/domain/docling-quality.ts), a pure function). It rejects the known bad shapes rather than judging style: empty or whole-page-picture output (photo-derived PDFs), non-Latin mojibake from a broken `ToUnicode` CMap, and OCR/decoration noise or ragged tables — reusing the same signals as `pdf-text.ts` and `markdown-tables.ts`.

Pass → the Markdown rides along as `docling_markdown` and Step C's chunk-by-chunk LLM conversion is **skipped for that file** (`markdown_content` is already structured). Fail → the normal chain runs unchanged, with no partial adoption. Any new failure mode you find belongs in this gate with a threshold calibrated on the real corpus, not in a caller.

## OCR is not swappable

PaddleOCR is the primary engine; Tesseract is the availability fallback and sets `ocr_degraded: true` on the result. The two are **not** interchangeable in quality — on a photographed ID card PaddleOCR returned clean numbered form fields where Tesseract returned line noise. A caller that already holds text for a file must check `ocr_degraded` **before** overwriting it with a re-analysis result; that is what the flag exists for. Language set is `fra`, `eng`, `vie`.

## The pre-registration quality gate

[`extraction-quality-gate.ts`](../../../src/domain/extraction-quality-gate.ts) runs in two layers:

1. **During Step C**, `assessChunkMarkdown` / `describeTableRepairNote` screen each chunk. A chunk with malformed table rows or an absurd column blow-out is re-converted **once, alone**, with a corrective note — the healthy chunks are left untouched and are not re-rolled.
2. **Before registration** (in `triage-scan`, after classification), `assessExtractionQuality` assesses the complete document and throws `ExtractionQualityGateError` — a typed, catchable error mirroring `OllamaUnavailableError`, so the web route, an MCP tool, or an agent can act on the structured `QualityGateReport` instead of parsing log lines.

The origin is doc 5009 (2026-09-03): a table came back with rows outside the GFM pipes, values dropped out entirely, and the pipeline stored it with no error — the integrity audit only sees lines that *start* with `|`, so the malformed rows were invisible.

**Every `QUALITY_GATE` threshold is deliberately conservative and corpus-calibrated** (recent docs 4991–5009: healthy documents pass with margin, the known-bad shapes fail). The gate exists to keep obviously unusable content out of the registry, where it silently corrupts FTS search, summaries and the chat assistant — not to reject documents with cosmetic quirks. Tightening a threshold needs corpus evidence, and loosening one to make a document pass needs a written reason.

## Verifying a change here

`npm run typecheck` and `npm test` — `src/domain/{docling-quality,extraction-quality-gate,markdown-tables,pdf-text}.test.ts` and `src/infrastructure/{pdf-extractor,pdf-extract-remote,docling-remote}*.test.ts` hold the behaviour. Then confirm the **fallback path still works with each URL unset**: an extraction change that only passes with `DOCLING_SERVICE_URL` or `PDF_EXTRACT_SERVICE_URL` set has broken the guarantee that documents never strand. Do not run `npm run dev` to check — see [pdf-triage-verify](../pdf-triage-verify/SKILL.md).
