# pdf2w Extraction Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the entire in-process + sidecar extraction stack (pdf-parse/pdfjs-dist Tiers 1-2, Canvas+PaddleOCR/Tesseract Tier 3, the optional Docling HTTP layer, and the Dockerized `src/extract-service` split) with a single, hard-required HTTP call to a new external service, **pdf2w** (Go gateway + Rust core), for every PDF and every photo-derived PDF.

**Architecture:** `extractPDFContent()` in `src/infrastructure/pdf-extractor.ts` becomes a thin wrapper around one new client, `src/infrastructure/pdf2w-remote.ts` (`POST /convert`, plain HTTP — no MCP client embedded in the app, per the approved design doc). No fallback branch exists: an unreachable pdf2w is a hard `FILE_FAILED`, the same posture as an unreachable Ollama today. The photo pipeline (`convert-image-document.ts`) stops OCR'ing before PDF assembly and instead hands its assembled image-only PDF to the same `extractPDFContent()` path as any scanned document.

**Tech Stack:** TypeScript (unchanged app side), Vitest for tests, `fetch`/`AbortSignal.timeout` for the new HTTP client (matching the existing `docling-remote.ts`/`pdf-extract-remote.ts` pattern) — pdf2w itself (Go/Rust) is out of scope for this plan; it is developed in the separate `pdf-triage-pdf2w` submodule repo and only its HTTP contract matters here.

**Source spec:** [`docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md`](../specs/2026-09-17-pdf2w-extraction-swap-design.md) — read it first; this plan operationalizes it and corrects three places where it deferred to implementation-time verification.

## Global Constraints

- Golden Rule 0 (Think First) — every task below already traces its imports; do not re-guess paths.
- Golden Rule 9 — the scan pipeline stays strictly sequential (one file at a time, 50 ms yield); pdf2w calls are no exception.
- Golden Rule 16 — no DI container, no new abstraction layers; `pdf2w-remote.ts` is a plain function module, same shape as its two predecessors.
- Golden Rule 17 — photo-pipeline invariants (never re-apply EXIF orientation, never reintroduce the crop-detector texture gate, never delete a source image) are untouched by this plan; only the OCR step changes.
- pdf2w is **required, not optional-with-fallback** — no `_REQUIRED` toggle, no silent degraded mode. This reverses the fallback philosophy every other seam in this app uses (`PDF_EXTRACT_SERVICE_URL`, `DOCLING_SERVICE_URL`) — that reversal is deliberate per the spec, not an oversight.
- Every task that deletes a file must also delete its `.test.ts` and remove it from nothing else (Vitest auto-discovers by glob; there is no test registry file to edit).
- `npm run typecheck` and `npm test` must be green after every task, not just at the end.

---

## Decisions needed before starting (read first)

The spec left three things "to be verified during implementation." They are now verified — here is what each verification found, and the one genuine judgment call each surfaces:

### 1. `src/infrastructure/orientation-detector.ts` — must be MODIFIED, not deleted

It runs an EXIF → vision-model → **PaddleOCR OSD** → Tesseract OSD cascade for the photo pipeline's `runOrientStep` (`image-to-pdf.ts`). PaddleOCR is only one tiebreaker leg, not its whole job — Golden Rule 17 governs this file and it has nothing to do with text extraction. **Judgment call:** dropping the PaddleOCR tiebreaker leg degrades orientation detection to EXIF+vision-model only. Task 7 below drops it (simplest, no pdf2w-equivalent orientation API exists) — flag to the user if orientation-detection quality regresses after this ships; re-adding a tiebreaker would need a new, separate signal.

### 2. `src/domain/ocr-layout.ts` — safe to delete outright

Its only production importer is `paddleocr-client.ts` (reordering OCR boxes into reading order). No other consumer exists. Deleted in Task 8 alongside the client.

### 3. Vision Lab's step 4 (`runExtractStep`) loses its local implementation

`src/vision-lab-server.ts` exposes `runOrientStep/runCropStep/runEnhanceStep/runExtractStep` as steps 1-4 of an interactive diagnostic tool. Step 4 currently calls `ocrImageBufferBothEngines` (PaddleOCR + Tesseract, side by side) — both are deleted by this plan. **Judgment call, not resolved here:** Task 6 removes `runExtractStep` and disables step 4 in the Vision Lab UI with a visible "extraction now happens via pdf2w, not previewable per-image here" message, rather than wiring Vision Lab to call pdf2w directly (that would be new scope — a diagnostic client for a service that has its own operators). Revisit if the user wants per-image pdf2w preview restored.

### 4. `doclingMarkdown` in `classify-document.ts` — repurposed, and Step C becomes unreachable

`classifyPDFText(rawText, filename, previousError, now, doclingMarkdown?)` currently skips the Step C LLM markdown pass when Docling's markdown passed its quality gate — an *optional* fast path. Since pdf2w is **required** and always returns `markdown`, every call after this migration will have a markdown value, which means **Step C's chunk-by-chunk LLM conversion (`convertRawTextToZeroLossMarkdown`) never runs again** — it becomes dead code reachable only if a future caller ever invokes `classifyPDFText` without the 5th argument. This plan (Task 5) keeps `convertRawTextToZeroLossMarkdown` in place rather than deleting it (deleting a whole quality mechanism is a bigger call than this swap should make silently), renames the parameter to `extractionMarkdown` for honesty, and flags this explicitly for the user: **confirm Step C should really go permanently dark, or whether pdf2w's markdown should only be adopted when it passes a gate (mirroring the old Docling gate) so Step C stays reachable as a fallback.** Task 5's steps implement the "always adopt, Step C dark" reading because that is what the spec's "no fallback branch, no optional layer" language says — but this is the single highest-impact reading in the whole plan and deserves a second look before merging.

### 5. `relocalize-document.ts`'s re-analysis quality guard reads a field this plan removes

`relocalize-document.ts:248` — `const rejectDegraded = !!extracted.ocr_degraded && storedText.trim().length > 10;` — rejects a fresh re-analysis in favor of the stored text specifically when the fresh extraction fell back to the weaker OCR engine. This guard exists because of a real incident (documented in the surrounding comment): 346 chars of Tesseract-fallback noise once silently replaced 433 chars of clean PaddleOCR text, and the title/date/summary/markdown were all rebuilt from the noise. Task 3 removes `ocr_degraded` from `ExtractedPDF` entirely (there is no local engine to degrade to — pdf2w is the only source). **This means the specific failure mode the guard was built for cannot recur the same way, but the guard itself goes away with no replacement** — Task 4 below deletes the `rejectDegraded` check rather than inventing a new one, since there is no equivalent "which of these two extractions is more trustworthy" signal pdf2w exposes yet (its `engine` field distinguishes native-vs-vision-rescue, which could become a future signal, but wiring that up is new scope this plan does not take on). Flag this to the user as a known, deliberate regression in the re-analysis safety net, not an oversight.

### 6. Sequencing against the in-flight OCR-quality WIP

At plan-writing time, `git status` shows **uncommitted work already improving the system this plan deletes**: `OCR_RENDER_SCALE` tuning, `chooseBestExtraction` corruption-arbitration (domain/pdf-text.ts, pdf-extractor.ts), and `paddleocr-server/` engine fixes. Recommendation: **commit and ship that WIP first**, on its own, before starting Task 1 below — it's real quality work with its own test coverage, and folding it into a branch that then deletes the same files a week later is confusing history for no benefit. This plan assumes that WIP is committed (or deliberately discarded) before Task 1 starts; it does not include steps to handle it.

---

## Task 1: Add pdf2w config to `settings.ts`

**Files:**
- Modify: `src/infrastructure/settings.ts:190-236` (the existing `PDF_EXTRACT_SERVICE_*`/`DOCLING_SERVICE_*` block — replaced, not appended alongside)
- Modify: `.env.example:56-104` (same replacement)
- Test: `src/infrastructure/settings.test.ts:106-131` (replace the `PADDLEOCR_HOST`/`PADDLEOCR_SPAWN_CMD` cases)

**Interfaces:**
- Produces: `CONFIG.PDF2W_SERVICE_URL: string`, `CONFIG.PDF2W_SERVICE_TIMEOUT_MS: number` — consumed by Task 3's `pdf2w-remote.ts`.

- [ ] **Step 1: Write the failing test**

In `src/infrastructure/settings.test.ts`, replace the existing `describe` block that tests `PADDLEOCR_HOST`/`PADDLEOCR_SPAWN_CMD` defaults (lines ~106-131) with:

```typescript
describe('PDF2W_SERVICE_URL / PDF2W_SERVICE_TIMEOUT_MS', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('defaults PDF2W_SERVICE_URL to empty and PDF2W_SERVICE_TIMEOUT_MS to 0', async () => {
    delete process.env.PDF2W_SERVICE_URL;
    delete process.env.PDF2W_SERVICE_TIMEOUT_MS;
    vi.resetModules();
    const { CONFIG } = await import('./settings.js');
    expect(CONFIG.PDF2W_SERVICE_URL).toBe('');
    expect(CONFIG.PDF2W_SERVICE_TIMEOUT_MS).toBe(0);
  });

  it('reads PDF2W_SERVICE_URL and a positive timeout from the environment', async () => {
    process.env.PDF2W_SERVICE_URL = 'http://127.0.0.1:3985';
    process.env.PDF2W_SERVICE_TIMEOUT_MS = '45000';
    vi.resetModules();
    const { CONFIG } = await import('./settings.js');
    expect(CONFIG.PDF2W_SERVICE_URL).toBe('http://127.0.0.1:3985');
    expect(CONFIG.PDF2W_SERVICE_TIMEOUT_MS).toBe(45000);
  });

  it('falls back to 0 for a negative or non-numeric timeout', async () => {
    process.env.PDF2W_SERVICE_TIMEOUT_MS = '-5';
    vi.resetModules();
    const { CONFIG: cfgNeg } = await import('./settings.js');
    expect(cfgNeg.PDF2W_SERVICE_TIMEOUT_MS).toBe(0);

    process.env.PDF2W_SERVICE_TIMEOUT_MS = 'not-a-number';
    vi.resetModules();
    const { CONFIG: cfgNaN } = await import('./settings.js');
    expect(cfgNaN.PDF2W_SERVICE_TIMEOUT_MS).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- settings.test.ts -t "PDF2W_SERVICE"`
Expected: FAIL — `CONFIG.PDF2W_SERVICE_URL` is `undefined`, property does not exist.

- [ ] **Step 3: Replace the config block**

In `src/infrastructure/settings.ts`, delete the `PADDLEOCR_HOST`/`PADDLEOCR_SPAWN_CMD` lines (part of the block around line 164 area — search for `PADDLEOCR_HOST`) and the entire `---- PDF text-extraction microservice ----` and `---- Docling structured-extraction service ----` blocks (lines 190-236 in the current WIP diff), replacing them with:

```typescript
  // ---- pdf2w extraction service (required — no local fallback) ------------------------------
  // pdf2w (Go gateway + Rust core, self-hosted, git submodule at services/pdf2w-extract/) is the
  // ONLY text-extraction path: every PDF and every photo-derived PDF is POSTed to it. Unlike the
  // PDF_EXTRACT_SERVICE_URL / DOCLING_SERVICE_URL seams it replaces, there is no _REQUIRED toggle
  // and no in-process fallback — an unreachable pdf2w is a hard FILE_FAILED for that document,
  // the same posture as an unreachable Ollama today. See
  // docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md.
  PDF2W_SERVICE_URL: (process.env.PDF2W_SERVICE_URL || '').trim(),
  // Per-request timeout, ms. 0 (default) = no client timeout — vision-rescue OCR of a scanned
  // page can legitimately take tens of seconds and the triage pipeline is strictly 1-by-1
  // sequential (Golden Rule #9), so a per-file timeout is a foot-gun, not a safeguard.
  PDF2W_SERVICE_TIMEOUT_MS: (() => {
    const raw = parseInt(process.env.PDF2W_SERVICE_TIMEOUT_MS || '0', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- settings.test.ts -t "PDF2W_SERVICE"`
Expected: PASS (3 tests)

- [ ] **Step 5: Update `.env.example`**

Replace `.env.example` lines 56-104 (the `PADDLEOCR_HOST` through `DOCLING_SERVICE_TIMEOUT_MS` blocks) with:

```
# ── pdf2w extraction service (required, no fallback) ───────────────────────────────────────────
# pdf2w (Go gateway + Rust core) is the ONLY text-extraction path for PDFs and photo-derived PDFs.
# Run it via the docker-compose service block in services/pdf2w-extract/ (git submodule), then
# point the app at it:
PDF2W_SERVICE_URL=http://127.0.0.1:3985
# Per-request timeout, ms. 0 (default) = no client timeout.
# PDF2W_SERVICE_TIMEOUT_MS=0
```

- [ ] **Step 6: Run the full settings + typecheck suite**

Run: `npm test -- settings.test.ts && npm run typecheck`
Expected: PASS. (Typecheck will still fail at this point because `pdf-extractor.ts` still imports the now-deleted config names — that's expected until Task 4. If you're executing tasks in order and Task 4 hasn't run yet, skip the typecheck half of this step and re-run it after Task 4.)

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/settings.ts src/infrastructure/settings.test.ts .env.example
git commit -m "feat(config): add PDF2W_SERVICE_URL/TIMEOUT_MS, remove paddleocr/docling/extract-service config"
```

---

## Task 2: Create `src/infrastructure/pdf2w-remote.ts`

**Files:**
- Create: `src/infrastructure/pdf2w-remote.ts`
- Test: `src/infrastructure/pdf2w-remote.test.ts`

**Interfaces:**
- Consumes: `CONFIG.PDF2W_SERVICE_URL`, `CONFIG.PDF2W_SERVICE_TIMEOUT_MS` (Task 1).
- Produces: `interface Pdf2wExtractResult { checksum: string; text: string; markdown: string; numpages: number; engine: string }` and `async function extractViaPdf2w(filePath: string): Promise<Pdf2wExtractResult>` — consumed by Task 4's rewritten `pdf-extractor.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/infrastructure/pdf2w-remote.test.ts`, modeled on the existing `paddleocr-client.test.ts` fetch-mocking convention (`vi.hoisted` + `vi.stubGlobal`):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tempPdf(bytes = 'not-really-a-pdf'): string {
  const p = path.join(os.tmpdir(), `pdf2w-remote-test-${Date.now()}-${Math.random()}.pdf`);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('extractViaPdf2w', () => {
  it('POSTs the file and returns the parsed extraction result', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        checksum: 'abc123',
        text: 'hello world',
        markdown: '# hello\n\nworld',
        numpages: 3,
        engine: 'native',
      }),
    });

    const { extractViaPdf2w } = await import('./pdf2w-remote.js');
    const filePath = tempPdf();
    const result = await extractViaPdf2w(filePath);

    expect(result).toEqual({
      checksum: 'abc123',
      text: 'hello world',
      markdown: '# hello\n\nworld',
      numpages: 3,
      engine: 'native',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/convert$/);
    expect(init.headers['x-file-name']).toBe(encodeURIComponent(path.basename(filePath)));

    fs.unlinkSync(filePath);
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });

    const { extractViaPdf2w } = await import('./pdf2w-remote.js');
    const filePath = tempPdf();
    await expect(extractViaPdf2w(filePath)).rejects.toThrow('503');
    fs.unlinkSync(filePath);
  });

  it('throws on transport failure (service unreachable)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { extractViaPdf2w } = await import('./pdf2w-remote.js');
    const filePath = tempPdf();
    await expect(extractViaPdf2w(filePath)).rejects.toThrow('ECONNREFUSED');
    fs.unlinkSync(filePath);
  });

  it('throws when the response is missing markdown or text', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ checksum: 'x', numpages: 1, engine: 'native' }),
    });

    const { extractViaPdf2w } = await import('./pdf2w-remote.js');
    const filePath = tempPdf();
    await expect(extractViaPdf2w(filePath)).rejects.toThrow('unexpected response shape');
    fs.unlinkSync(filePath);
  });

  it('defaults numpages to 1 when the service omits it or sends a non-positive value', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ checksum: 'x', text: 't', markdown: 'm', engine: 'native' }),
    });

    const { extractViaPdf2w } = await import('./pdf2w-remote.js');
    const filePath = tempPdf();
    const result = await extractViaPdf2w(filePath);
    expect(result.numpages).toBe(1);
    fs.unlinkSync(filePath);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pdf2w-remote.test.ts`
Expected: FAIL — cannot find module `./pdf2w-remote.js`.

- [ ] **Step 3: Write the implementation**

Create `src/infrastructure/pdf2w-remote.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';

/**
 * HTTP client for pdf2w (Go gateway + Rust core, git submodule at services/pdf2w-extract/) — the
 * ONLY text-extraction path for PDFs and photo-derived PDFs. See
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md.
 *
 * Contract: POST /convert, raw file bytes + X-File-Name header →
 *   200 { checksum, text, markdown, numpages, engine }
 *
 * No fallback exists on the app side for this client — the caller (extractPDFContent in
 * pdf-extractor.ts) turns any thrown error here into a hard FILE_FAILED for that document.
 * Deliberately NO default timeout: vision-rescue OCR of a scanned page can take tens of seconds
 * and the triage pipeline is strictly 1-by-1 sequential (Golden Rule #9). Set
 * PDF2W_SERVICE_TIMEOUT_MS to impose one anyway.
 */
export interface Pdf2wExtractResult {
  checksum: string;
  text: string;
  markdown: string;
  numpages: number;
  engine: string;
}

export function isPdf2wConfigured(): boolean {
  return CONFIG.PDF2W_SERVICE_URL.length > 0;
}

export async function extractViaPdf2w(filePath: string): Promise<Pdf2wExtractResult> {
  const baseUrl = CONFIG.PDF2W_SERVICE_URL.replace(/\/+$/, '');
  const fileBuffer = fs.readFileSync(filePath);
  const filename = encodeURIComponent(path.basename(filePath));
  const timeoutMs = CONFIG.PDF2W_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': filename,
    },
    body: fileBuffer as unknown as BodyInit,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(
      `pdf2w service returned ${res.status} ${res.statusText} for '${path.basename(filePath)}'`
    );
  }

  const data: any = await res.json();
  if (
    typeof data !== 'object' || data === null ||
    typeof data.markdown !== 'string' ||
    typeof data.text !== 'string'
  ) {
    throw new Error('pdf2w service returned an unexpected response shape (missing markdown/text)');
  }

  return {
    checksum: typeof data.checksum === 'string' ? data.checksum : '',
    text: data.text,
    markdown: data.markdown,
    numpages: typeof data.numpages === 'number' && data.numpages >= 1 ? data.numpages : 1,
    engine: typeof data.engine === 'string' ? data.engine : 'unknown',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pdf2w-remote.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/pdf2w-remote.ts src/infrastructure/pdf2w-remote.test.ts
git commit -m "feat(extraction): add pdf2w HTTP client"
```

---

## Task 3: Rewrite `extractPDFContent()` routing in `pdf-extractor.ts`

This is the biggest single change. It deletes the entire in-process extraction chain (Tiers 1-3), the Docling routing wrapper, and the remote-extract-service routing wrapper, replacing all of it with one hard-required pdf2w call.

**Files:**
- Modify: `src/infrastructure/pdf-extractor.ts` (delete lines ~1-668 body of `extractPDFContentLocal` and everything after it down to end of file per the current WIP diff; replace with the version below)
- Modify: `src/infrastructure/http/web-server.ts:13,1563-1572` (remove `takeOverPaddleOcrServer` import + boot-time call)
- Delete: `src/infrastructure/pdf-extractor-routing.test.ts`, `src/infrastructure/pdf-extractor-docling-routing.test.ts`
- Modify: `src/infrastructure/pdf-extractor.test.ts` (rewrite to test the new pdf2w-only routing)
- Modify: `src/domain/pdf-text.ts` (delete `detectThinTextLayer`, `chooseBestExtraction`, `detectMidWordCapitalizationCorruption` and their exports — keep `cleanExtractedText`)
- Modify: `src/domain/pdf-text.test.ts` (delete the `describe` blocks for the three deleted functions)

**Interfaces:**
- Consumes: `extractViaPdf2w` (Task 2), `isPdf2wConfigured` (Task 2).
- Produces: `extractPDFContent(filePath: string): Promise<ExtractedPDF>` — same exported name and shape every other file imports (`triage-scan.ts`, `relocalize-document.ts`, `repair-registry.ts` are unaffected by this signature). `ExtractedPDF` gains `markdown: string` (always present now, replacing the optional `docling_markdown?`), drops `ocr_degraded?` (no local OCR engine to degrade to).

- [ ] **Step 1: Write the failing test**

Rewrite `src/infrastructure/pdf-extractor.test.ts` (delete its existing content entirely — the old file tests the in-process OCR chain, `ocrImageBufferBothEngines`, and mocks `./paddleocr-client.js`, none of which exist after this task):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock('./pdf2w-remote.js', () => ({
  extractViaPdf2w: extractMock,
  isPdf2wConfigured: () => true,
}));

beforeEach(() => {
  vi.resetModules();
  extractMock.mockReset();
});

function tempFile(bytes = 'fake-pdf-bytes'): string {
  const p = path.join(os.tmpdir(), `pdf-extractor-test-${Date.now()}-${Math.random()}.pdf`);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('extractPDFContent', () => {
  it('delegates to pdf2w and returns its result under the ExtractedPDF contract', async () => {
    extractMock.mockResolvedValueOnce({
      checksum: 'ignored-should-be-recomputed',
      text: 'hello world',
      markdown: '# Hello\n\nworld',
      numpages: 2,
      engine: 'native',
    });

    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile('actual bytes on disk');
    const result = await extractPDFContent(filePath);

    const expectedChecksum = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    expect(result.checksum).toBe(expectedChecksum); // recomputed locally, never trusted from the service
    expect(result.raw_text).toBe('hello world');
    expect(result.markdown).toBe('# Hello\n\nworld');
    expect(result.numpages).toBe(2);

    fs.unlinkSync(filePath);
  });

  it('throws a clear error (no fallback) when pdf2w is unreachable', async () => {
    extractMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile();
    await expect(extractPDFContent(filePath)).rejects.toThrow(/pdf2w/i);
    fs.unlinkSync(filePath);
  });

  it('throws a clear error when PDF2W_SERVICE_URL is not configured', async () => {
    vi.doMock('./pdf2w-remote.js', () => ({
      extractViaPdf2w: extractMock,
      isPdf2wConfigured: () => false,
    }));

    const { extractPDFContent } = await import('./pdf-extractor.js');
    const filePath = tempFile();
    await expect(extractPDFContent(filePath)).rejects.toThrow('PDF2W_SERVICE_URL');
    fs.unlinkSync(filePath);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pdf-extractor.test.ts`
Expected: FAIL — old `extractPDFContent` doesn't call `pdf2w-remote.js`, `result.markdown` is undefined, old routing has fallback behavior instead of throwing.

- [ ] **Step 3: Replace `pdf-extractor.ts`'s extraction body**

Delete `extractPDFContentLocal` in its entirety (Tier 1 pdf-parse, Tier 2 pdfjs-dist recovery, Tier 3 Canvas+OCR, DOCX/XLSX/TXT branches, corruption detection/arbitration) and the whole "Remote-extraction routing" section (`tryDoclingExtraction`, `isRemoteExtractionConfigured`, the old `extractPDFContent` wrapper). Also delete now-unused imports: `pdfjs-dist` types, `@napi-rs/canvas`'s `createCanvas` (only used by the deleted OCR-render path — `image-processor.ts` has its own canvas usage, untouched), `createWorker` from `tesseract.js`, `paddleOcrRecognize`, `extractPDFContentRemote`, `isDoclingExtractionConfigured`/`isDoclingExtractionRequired`/`extractDoclingContent`, `assessDoclingMarkdown`, `cleanExtractedText`'s now-unused corruption-signal siblings.

Keep: file-type detection (image branch for direct `.jpg` calls, `.docx`/`.xlsx`/`.txt` text-extraction helpers if they don't route through pdf2w per the spec — **check the spec's scope**: it says "PDF or photo," not office files, so DOCX/XLSX/TXT extraction stays exactly as it is today, untouched by this plan) and `ocrImageBufferBothEngines`'s *type* if still referenced (it isn't — deleted in Task 6).

Replace with:

```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { CONFIG } from './settings.js';
import { cleanExtractedText } from '../domain/pdf-text.js';
import { extractViaPdf2w, isPdf2wConfigured } from './pdf2w-remote.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  /** pdf2w's structured Markdown export — always present, since pdf2w is required. */
  markdown: string;
}

// [... keep the untouched DOCX/XLSX/TXT extraction helpers here, unchanged from today ...]

/**
 * Every PDF and every photo-derived PDF is sent to pdf2w — the only extraction path. There is no
 * fallback: an unreachable or misbehaving pdf2w is a hard error, and the caller (triage-scan.ts)
 * turns that into a FILE_FAILED block, keeping the document in __raws — same posture as an
 * unreachable Ollama today. See docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md
 * for why this reverses the fallback philosophy every other extraction seam in this app used.
 */
export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  if (!isPdf2wConfigured()) {
    throw new Error(
      `PDF2W_SERVICE_URL is not configured — pdf2w is required for extraction, there is no fallback. Set it in .env.`
    );
  }

  const filename = path.basename(filePath);
  let remote;
  try {
    remote = await extractViaPdf2w(filePath);
  } catch (err: any) {
    throw new Error(`pdf2w extraction failed for '${filename}': ${err.message}`);
  }

  logger.info('PDF_PARSER', `pdf2w extraction (${remote.engine}) for '${filename}' — ${remote.text.length} chars`, {
    filename,
    engine: remote.engine,
  });

  return {
    // Checksum computed locally, not trusted from the service — it is the dedupe key, and it must
    // be the sha256 of the exact bytes on disk regardless of what the service echoes back.
    checksum: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    raw_text: cleanExtractedText(remote.text),
    numpages: remote.numpages,
    info: {},
    markdown: remote.markdown,
  };
}
```

(Adjust the "keep the untouched DOCX/XLSX/TXT extraction helpers" placeholder by literally cutting those existing functions from the current file and pasting them below the imports, unmodified — they are not part of this task's scope per the spec, which only replaces "PDF or photo" extraction.)

- [ ] **Step 4: Remove the boot-time PaddleOCR takeover call**

In `src/infrastructure/http/web-server.ts`, delete line 13 (`import { takeOverPaddleOcrServer } from '../paddleocr-client.js';`) and the block around lines 1563-1572 that awaits it and logs the restart message.

- [ ] **Step 5: Delete obsolete routing test files**

```bash
git rm src/infrastructure/pdf-extractor-routing.test.ts src/infrastructure/pdf-extractor-docling-routing.test.ts
```

- [ ] **Step 6: Trim `pdf-text.ts`**

In `src/domain/pdf-text.ts`, delete the exported functions `detectThinTextLayer`, `chooseBestExtraction`, `detectMidWordCapitalizationCorruption` and the `CorruptionSignal` type (their only consumer, the deleted in-process chain, is gone). Keep `cleanExtractedText` and anything it depends on. In `src/domain/pdf-text.test.ts`, delete the `describe` blocks that test the three removed functions.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- pdf-extractor.test.ts pdf-text.test.ts settings.test.ts && npm run typecheck`
Expected: PASS. Typecheck may still show errors from files not yet updated (Tasks 4-8) — if so, note which files and continue; a fully green typecheck is the plan's overall exit criterion, not this task's alone.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/pdf-extractor.ts src/infrastructure/pdf-extractor.test.ts src/infrastructure/http/web-server.ts src/domain/pdf-text.ts src/domain/pdf-text.test.ts
git rm src/infrastructure/pdf-extractor-routing.test.ts src/infrastructure/pdf-extractor-docling-routing.test.ts
git commit -m "feat(extraction): route extractPDFContent through pdf2w only, no fallback"
```

---

## Task 4: Update `classify-document.ts` for the always-present markdown

**Files:**
- Modify: `src/application/classify-document.ts:383-451` (the `classifyPDFText` signature and Step C gate)
- Modify: `src/application/classify-document.test.ts:274-320` (the `doclingMarkdown` contract tests)
- Modify: `src/application/triage-scan.ts` (~line 290 call site)
- Modify: `src/application/relocalize-document.ts` (~lines 233, 248 — call site AND the `rejectDegraded` guard, see Decision #5)
- Modify: `src/application/repair-registry.ts` (~line 83 call site — missing from the source spec's own deletion table, found via dependency verification)

**Interfaces:**
- Consumes: `ExtractedPDF.markdown` (Task 3, always a string now, never undefined).
- Produces: `classifyPDFText(rawText, filename, previousError?, now?, extractionMarkdown?: string)` — same position, renamed parameter, same behavior contract callers rely on.

- [ ] **Step 1: Write the failing test**

In `src/application/classify-document.test.ts`, the existing tests at lines 274-320 already prove this exact contract against the old `doclingMarkdown` parameter name, by counting `generateMock` calls (3 = health + Step A + Step D, Step C skipped; 4 = Step C ran). Rename the parameter throughout both tests — no new test needed, this is a rename, not new behavior:

```typescript
  it('uses pdf2w markdown as markdown_content and SKIPS the Step C chunk-by-chunk LLM conversion when extractionMarkdown is provided', async () => {
    const pdf2wMd = [
      '# Relevé de compte Crédit Mutuel',
      '',
      '| Date | Opération | Débit |',
      '| --- | --- | --- |',
      '| 03/10/2023 | PRLV SEPA PAYPAL | -2,00 EUR |',
      '| 28/09/2023 | VIR DE MME DUPONT MARIE | +1 000,00 EUR |',
    ].join('\n');

    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'Crédit Mutuel', document_type: 'Bank Statement' }) }) // Step A
      .mockResolvedValueOnce({ // Step D — note: NO Step C mock in between
        response: JSON.stringify({
          titre: 'Relevé Crédit Mutuel', registre: '', date: '2023-10-03',
          categorie: 'bank', subcategorie: 'credit_mutuel', summary: 's', tags: [],
        }),
      });

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('Relevé Crédit Mutuel PAYPAL DUPONT', 'releve.pdf', undefined, undefined, pdf2wMd);

    // health + Step A + Step D only — Step C never ran.
    expect(generateMock).toHaveBeenCalledTimes(3);
    // The deterministic pdf2w markdown IS the stored markdown_content.
    expect(result.markdown_content).toBe(pdf2wMd);
    expect(result.categorie).toBe('bank');
  });

  it('still runs the normal Step C path when extractionMarkdown is empty/whitespace', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'SFR', document_type: 'Invoice' }) }) // Step A
      .mockResolvedValueOnce({ response: '# SFR\n\n**Total TTC:** 45.99€' }) // Step C (empty extractionMarkdown must not suppress it)
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: '', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 's', tags: [],
        }),
      }); // Step D

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf', undefined, undefined, '   ');

    expect(generateMock).toHaveBeenCalledTimes(4); // health + Step A + Step C + Step D
    expect(result.categorie).toBe('invoices');
  });
```

This is the existing test content (lines 274-320 of the current file) with `doclingMarkdown`/`docling` renamed to `extractionMarkdown`/`pdf2w` — the assertions (call-count-based Step C detection) do not need to change, since the skip/run contract itself is unchanged, only which service produces the markdown. **One further change from the real current file: its fixture row uses a real person's name (`prompt-hygiene.test.ts`'s `PERSONAL_NAME_DENYLIST` guard already flags this file for it) — this plan's version above replaces it with a fabricated name (`DUPONT MARIE`) instead. Apply that same substitution when editing the real file, not just this plan's copy — carrying the real name forward here would keep tripping the hygiene guard indefinitely.**

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- classify-document.test.ts -t "SKIPS the Step C"`
Expected: FAIL — `classifyPDFText`'s 5th parameter is still named `doclingMarkdown` at this point; the renamed test calling it positionally still passes the value correctly (it's positional, not named), so the actual failure is TypeScript-level once you run `npm run typecheck` (the doc comment/param name mismatch is cosmetic until Step 3, so this specific test may in fact PASS already — if it does, that's fine, proceed to Step 3 anyway since the doc-comment/naming clarity is still the point of this task, then confirm the full file's 2 tests plus typecheck are green in Step 5).

- [ ] **Step 3: Rename the parameter**

In `src/application/classify-document.ts`, rename the 5th parameter of `classifyPDFText` from `doclingMarkdown` to `extractionMarkdown` and update its doc comment:

```typescript
export async function classifyPDFText(
  rawText: string,
  filename: string,
  previousError?: string,
  now: Date = new Date(),
  // pdf2w's structured Markdown export (always present once pdf2w is configured — it is a
  // required service, not an optional quality layer). When provided, Step C's LLM chunk-by-chunk
  // conversion is SKIPPED — pdf2w already produced the structure Step C exists to rebuild, and
  // asking the model to re-derive it would re-introduce the truncation/reconstruction losses
  // Step C's own machinery exists to catch. See
  // docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md Decision #4 for the tradeoff
  // this creates: Step C is now unreachable in production unless a future caller deliberately
  // omits this argument.
  extractionMarkdown?: string
): Promise<DocumentMetadata> {
```

And update the two internal references (`doclingMarkdown` → `extractionMarkdown`) at what is currently lines 394 and 444.

- [ ] **Step 4: Update all three call sites precisely**

Three files read the old optional/cast `docling_markdown` field and pass it to `classifyPDFText`. Since Task 3 makes `markdown` a plain required `string` on `ExtractedPDF` (no cast needed anymore), each simplifies:

In `src/application/triage-scan.ts` (~line 290), replace:

```typescript
      const doclingMarkdown = !converted ? (extracted as { docling_markdown?: string }).docling_markdown : undefined;
      const metadata = doclingMarkdown && doclingMarkdown.trim().length > 0
        ? await classifyPDFText(raw_text, file, undefined, undefined, doclingMarkdown)
        : await classifyPDFText(raw_text, file);
```

with:

```typescript
      // pdf2w's structured Markdown always rides along with the extraction (Task 3's ExtractedPDF
      // contract) so Step C's LLM chunk-by-chunk conversion is always skipped now — see
      // docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md Decision #4.
      const extractionMarkdown = !converted ? (extracted as { markdown?: string }).markdown : undefined;
      const metadata = extractionMarkdown && extractionMarkdown.trim().length > 0
        ? await classifyPDFText(raw_text, file, undefined, undefined, extractionMarkdown)
        : await classifyPDFText(raw_text, file);
```

The `!converted` guard is temporary and becomes a latent bug once Task 5 runs (below): Task 5 makes `extracted.markdown` unconditionally valid for photos too (they go through the same `extractPDFContent()` call as everything else), so `!converted ? extracted.markdown : undefined` would then silently discard a perfectly good markdown for every photo, keeping Step C running for photos only. Task 5 includes an explicit step to remove this guard — do not skip it.

In `src/application/relocalize-document.ts` (~lines 233, 248), replace:

```typescript
  const freshDoclingMarkdown = (extracted as { docling_markdown?: string }).docling_markdown;
```

with:

```typescript
  const freshExtractionMarkdown = extracted.markdown;
```

and delete the `rejectDegraded` line and its usage entirely (~line 248 and wherever it's later read) — see Decision #5 above. Update every downstream reference from `freshDoclingMarkdown` to `freshExtractionMarkdown` and from the deleted `rejectDegraded` variable to whatever the surrounding `if` now reduces to (read the function's full body before editing — this guard sits inside a larger "never make the record worse" decision tree with other conditions that must NOT be touched).

In `src/application/repair-registry.ts` (~line 83), replace:

```typescript
      const doclingMarkdown = (extractedFile as { docling_markdown?: string }).docling_markdown;
```

with:

```typescript
      const extractionMarkdown = extractedFile.markdown;
```

and update its call to `classifyPDFText` (search `grep -n "classifyPDFText(" src/application/repair-registry.ts` — the plan's earlier grep for this file was incomplete; this file was missing from the original call-site list and must not be skipped).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- classify-document.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/classify-document.ts src/application/classify-document.test.ts src/application/triage-scan.ts src/application/relocalize-document.ts
git commit -m "refactor(classify): rename doclingMarkdown to extractionMarkdown for pdf2w"
```

---

## Task 5: Photo pipeline — stop OCR'ing before assembly

**Files:**
- Modify: `src/application/convert-image-document.ts:121-166` (`renderPageFromImage` — drop the OCR step)
- Modify: `src/application/convert-image-document.ts:273-312, 327-385` (`convertImageToPdf`/`convertImageFolderToPdf` — no longer return `rawText`, since text now comes from the same `extractPDFContent()` path as any other PDF)
- Modify: `src/application/image-to-pdf.ts` (delete `runExtractStep`, remove the now-unused import of `ocrImageBufferBothEngines`)
- Modify: `src/infrastructure/pdf-extractor.ts` (delete `ocrImageBufferBothEngines` — already gone if Task 3 deleted the whole in-process chain; if it survived because it was structurally separate, delete it now)
- Modify: `src/vision-lab-server.ts:5,13` (remove `runExtractStep` import and the `4: runExtractStep` map entry — see Decision #3 above for the UI-side message)
- Modify: `src/application/convert-image-document.test.ts` (rewrite the `'returns the OCR text so the caller never has to OCR the document a second time'` test at line ~175, and update the folder-bundle text-concatenation test at line ~340)
- Modify: `src/application/image-to-pdf.test.ts` (delete the `describe('runExtractStep', ...)` block, lines ~282-onward)
- Modify: `src/application/triage-scan.ts` (find the call site that reads `convertedDoc.rawText` and skips `extractPDFContent` for photos — remove that skip; photos now always go through `extractPDFContent` like any PDF)

**Interfaces:**
- Consumes: `extractPDFContent` (Task 3) — now called for photo-derived PDFs too, not skipped.
- Produces: `ConvertedImageDocument` drops the `rawText` field (text no longer travels out of the photo pipeline in memory).

- [ ] **Step 1: Write the failing test**

In `src/application/convert-image-document.test.ts`, replace the test at line ~175 (`'returns the OCR text so the caller never has to OCR the document a second time'`) with its opposite:

```typescript
it('does NOT run OCR before assembly — text now comes from extractPDFContent like any other PDF', async () => {
  const result = await convertImageToPdf(fixturePhotoPath);
  expect(result).not.toHaveProperty('rawText');
  // The assembled PDF has an image but no text layer — extractPDFContent (pdf2w) is responsible
  // for reading it, exactly like a scanned PDF that arrived as a .pdf directly.
});
```

(Use whatever fixture-path variable the surrounding tests already use — check the top of the file for the existing `fixturePhotoPath`-equivalent constant rather than inventing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- convert-image-document.test.ts -t "does NOT run OCR"`
Expected: FAIL — `result.rawText` still exists.

- [ ] **Step 3: Simplify `renderPageFromImage`**

In `src/application/convert-image-document.ts`, replace `renderPageFromImage` (currently returns `{ pageJpeg, rawText }`) with a version that drops the extract step entirely:

```typescript
/**
 * Runs one photograph through the vision pipeline's geometry stages and returns the page image.
 *
 * Every stage degrades gracefully: orientation and crop each either improve the buffer or leave
 * it untouched, so there is always something publishable no matter how far the pipeline gets.
 * Text is no longer read here — the assembled PDF goes through the same extractPDFContent() /
 * pdf2w path as any other PDF, so a photo and a scanned PDF get their text from the same place.
 */
async function renderPageFromImage(
  imagePath: string,
  docLog: ReturnType<typeof logger.forDocument>
): Promise<{ pageJpeg: Buffer }> {
  const filename = path.basename(imagePath);
  const imageBuffer = fs.readFileSync(imagePath);

  let pageBuffer = imageBuffer;

  const oriented = await runOrientStep(imageBuffer);
  if (oriented.error || !oriented.imageBase64) {
    docLog.warn('IMG2PDF', `Orientation failed, using the photo as-is: ${oriented.error}`, { filename });
  } else {
    pageBuffer = Buffer.from(oriented.imageBase64, 'base64');
  }

  const cropped = await runCropStep(pageBuffer);
  if (cropped.error || !cropped.imageBase64) {
    docLog.warn('IMG2PDF', `Crop failed, keeping the uncropped page: ${cropped.error}`, { filename });
  } else {
    pageBuffer = Buffer.from(cropped.imageBase64, 'base64');
  }

  // Enhancement still runs — it improves legibility for pdf2w's vision-rescue path the same way
  // it improved PaddleOCR's read before. But since the archived page must be the natural-toned
  // CROPPED image (not the contrast-pushed one — see this file's header comment on why), and
  // pdf2w reads whatever bitmap ends up embedded in the PDF, the enhanced buffer is what gets
  // embedded now, not the cropped one. This is a real quality tradeoff versus today's behavior
  // (archive natural tones, OCR the enhanced copy) — flag it if archived photo quality visibly
  // drops; the alternative is embedding the cropped buffer and losing the enhancement's benefit
  // to pdf2w's OCR entirely.
  let pageBuffer2 = pageBuffer;
  const enhanced = await runEnhanceStep(pageBuffer);
  if (!enhanced.error && enhanced.imageBase64) {
    pageBuffer2 = Buffer.from(enhanced.imageBase64, 'base64');
  } else {
    docLog.warn('IMG2PDF', `Enhancement failed, archiving the unenhanced page: ${enhanced.error}`, { filename });
  }

  return { pageJpeg: await encodeJpeg(pageBuffer2, ARCHIVE_JPEG_QUALITY) };
}
```

**Stop and flag to the user before continuing past this step**: the comment above documents a real behavioral fork the spec didn't resolve (it says enhancement "only ever feeds OCR and is never archived" today, but there is no longer an OCR step to feed once extraction happens after assembly). Confirm which buffer should be archived — natural-toned cropped (today's archived copy, degrades pdf2w's read) or enhanced (better for pdf2w, changes what's archived) — before merging this step. The code above picks "archive enhanced" as the reading that keeps a text-bearing image legible to pdf2w's vision-rescue, but this is exactly the kind of quality-affecting default this plan should not silently lock in.

- [ ] **Step 4: Update the two conversion entry points**

In `convertImageToPdf` and `convertImageFolderToPdf`, remove `rawText`/`pageTexts` handling (the destructured `{ pageJpeg, rawText }` becomes `{ pageJpeg }`, `pageTexts.push(rawText)` lines are deleted, `return { ... rawText, ... }` drops the field), and update `ConvertedImageDocument`:

```typescript
export interface ConvertedImageDocument {
  pdfPath: string;
  checksum: string;
  /** 1 for a single photo, N for a folder bundled into one multi-page document. */
  pageCount: number;
  sourceImagePath: string;
}
```

- [ ] **Step 5: Update `triage-scan.ts`'s photo branch**

At `src/application/triage-scan.ts:211-212`, replace:

```typescript
      const extracted = converted
        ? { checksum: converted.checksum, raw_text: converted.rawText }
        : await extractPDFContent(originalPath);
```

with:

```typescript
      // Photos no longer short-circuit extraction with in-memory OCR text — the assembled PDF
      // goes through the same pdf2w path as any other document (Task 5 of
      // docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md).
      const extracted = await extractPDFContent(originalPath);
```

This finishes the cleanup Task 4 flagged: at ~line 290, replace the now-stale guard:

```typescript
      const extractionMarkdown = !converted ? (extracted as { markdown?: string }).markdown : undefined;
```

with a plain, unconditional field read — `extracted.markdown` is now valid for photos too, not just direct PDFs:

```typescript
      const extractionMarkdown = extracted.markdown;
```

Skipping this step leaves photos silently running Step C's LLM markdown conversion even though pdf2w already produced good structured markdown for them — a real, easy-to-miss regression, not a style nit.

- [ ] **Step 6: Delete `runExtractStep` and its dependency**

In `src/application/image-to-pdf.ts`, delete the `runExtractStep` function and the `import { ocrImageBufferBothEngines } from '../infrastructure/pdf-extractor.js';` line. In `src/infrastructure/pdf-extractor.ts`, confirm `ocrImageBufferBothEngines` has no remaining importers (`grep -rn "ocrImageBufferBothEngines" src`) and delete it if Task 3 didn't already remove it as part of the in-process chain.

In `src/vision-lab-server.ts`, remove `runExtractStep` from the import (line 5) and the `4: runExtractStep,` map entry (line 13) — per Decision #3, leave a comment explaining step 4 is retired, not silently drop the key without explanation:

```typescript
// Step 4 (extract) retired 2026-09-17: text extraction now happens exclusively via pdf2w after
// the PDF is assembled, not per-image here. See
// docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md Decision #3.
```

- [ ] **Step 7: Delete `runExtractStep`'s tests**

In `src/application/image-to-pdf.test.ts`, delete the `describe('runExtractStep', ...)` block (~line 282 onward).

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- convert-image-document.test.ts image-to-pdf.test.ts image-to-pdf.integration.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/application/convert-image-document.ts src/application/convert-image-document.test.ts src/application/image-to-pdf.ts src/application/image-to-pdf.test.ts src/application/triage-scan.ts src/infrastructure/pdf-extractor.ts src/vision-lab-server.ts
git commit -m "feat(photo-pipeline): stop OCR before assembly, route through pdf2w after"
```

---

## Task 6: Trim `orientation-detector.ts`'s PaddleOCR tiebreaker leg

**Files:**
- Modify: `src/infrastructure/orientation-detector.ts` (remove the `paddleOcrDetectOrientation` import and its branch from the cascade — see Decision #1)
- Modify: `src/infrastructure/orientation-detector.test.ts` (delete the test cases exercising the PaddleOCR tiebreaker leg)

**Interfaces:**
- Produces: `detectOrientationCascade` — same exported name and return shape (`OrientationDetectionResult`), one fewer signal contributing to it.

- [ ] **Step 1: Read the current cascade order**

Run: `grep -n "paddleOcrDetectOrientation\|detectOrientationViaVisionModel\|parseExifOrientation" src/infrastructure/orientation-detector.ts` and open the file around each match to see exactly where the PaddleOCR branch sits relative to EXIF/vision-model/Tesseract-OSD, so the edit below removes only that branch and doesn't reorder the rest.

- [ ] **Step 2: Write the failing test (removal, not addition)**

In `src/infrastructure/orientation-detector.test.ts`, find and delete every test that mocks/asserts on `paddleOcrDetectOrientation` (search `grep -n "paddleOcrDetectOrientation" src/infrastructure/orientation-detector.test.ts`). This is a removal step — there is no new behavior to assert, only old behavior to stop asserting. Run the suite once before deleting to capture which test names reference it, so none are missed.

- [ ] **Step 3: Remove the PaddleOCR branch and import**

In `src/infrastructure/orientation-detector.ts`:
- Delete `import { paddleOcrDetectOrientation } from './paddleocr-client.js';`
- Delete the cascade branch that calls it (the tiebreaker step between the vision-model result and the Tesseract OSD fallback — read Step 1's grep output to find its exact bounds).
- Update the file's own header comment if it names PaddleOCR as part of the cascade, so the comment doesn't describe a signal that no longer runs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orientation-detector.test.ts && npm run typecheck`
Expected: PASS — remaining tests (EXIF, vision-model, Tesseract OSD paths) unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/orientation-detector.ts src/infrastructure/orientation-detector.test.ts
git commit -m "refactor(orientation): drop the PaddleOCR tiebreaker leg (service is being deleted)"
```

---

## Task 7: Delete the extraction stack

Everything in this task is deletion — no new code, no tests to write. Run the full suite before and after to prove nothing outside this list still depends on what's removed.

**Files to delete:**

| Path | Why it's safe now |
| --- | --- |
| `paddleocr-server/` (whole directory) | Last app-side importer (`paddleocr-client.ts`) is deleted in this same task |
| `src/infrastructure/paddleocr-client.ts` + `.test.ts` | Its three importers are all gone by this point: `pdf-extractor.ts` (Task 3), `orientation-detector.ts` (Task 6), `web-server.ts` (Task 3) |
| `src/domain/ocr-layout.ts` + `.test.ts` | Only importer was `paddleocr-client.ts` |
| `src/infrastructure/docling-remote.ts` | Only importer was `pdf-extractor.ts` (Task 3) |
| `src/domain/docling-quality.ts` + `.test.ts` | Only importers were `pdf-extractor.ts` (Task 3) and `docling-remote.ts` (this task) |
| `src/infrastructure/pdf-extract-remote.ts` | Only importer was `pdf-extractor.ts` (Task 3) |
| `src/extract-service/` (whole directory: `app.ts`, `main.ts`, `app.test.ts`) | Never imported from `src/index.ts`; its own process, no remaining consumer |
| `Dockerfile.extract-service` | Builds the now-deleted `src/extract-service/` |

- [ ] **Step 1: Run the full suite before deleting, and record the count**

Run: `npm test 2>&1 | tail -20`
Expected: current pass count noted (e.g. "312 passed"), so Step 4 can confirm the right number of tests disappeared (the deleted files' own tests) rather than something unrelated breaking silently.

- [ ] **Step 2: Delete every path in the table**

```bash
git rm -r paddleocr-server/
git rm src/infrastructure/paddleocr-client.ts src/infrastructure/paddleocr-client.test.ts
git rm src/domain/ocr-layout.ts src/domain/ocr-layout.test.ts
git rm src/infrastructure/docling-remote.ts
git rm src/domain/docling-quality.ts src/domain/docling-quality.test.ts
git rm src/infrastructure/pdf-extract-remote.ts
git rm -r src/extract-service/
git rm Dockerfile.extract-service
```

- [ ] **Step 3: Remove `package.json`'s extract-service script and dead dependencies**

In `package.json`, delete the `"extract:dev": "tsx src/extract-service/main.ts"` script. Then confirm which of `pdfjs-dist` and `pdf-parse` still have importers:

```bash
grep -rln "pdfjs-dist" src --include="*.ts"
grep -rln "pdf-parse" src --include="*.ts"
```

Expected: no matches for either (both were only used by the now-deleted in-process extraction chain). Remove both from `dependencies`. **Do not** remove `tesseract.js` (still used by `orientation-detector.ts`'s Tesseract OSD fallback) or `@napi-rs/canvas` (used by `vision-client.ts`, `crop-detector.ts`, `image-processor.ts`, `convert-image-document.ts` — none of them deleted by this plan).

```bash
npm install   # regenerates package-lock.json without the removed deps
```

- [ ] **Step 4: Run the full suite and confirm the count**

Run: `npm test 2>&1 | tail -20 && npm run typecheck`
Expected: PASS, with exactly the deleted files' own tests gone from the total (no unrelated regressions — if the count dropped by more than the deleted `.test.ts` files' own test counts, something outside this list still depended on a deleted module; find it with `grep -rn "paddleocr\|docling\|pdf-extract-remote\|extract-service" src --include="*.ts"` before proceeding).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(extraction): delete paddleocr-server, docling-remote, extract-service — superseded by pdf2w"
```

---

## Task 8: `docker-compose.yml` + `.env.example` cleanup, pdf2w submodule wiring

**Files:**
- Modify: `docker-compose.yml` (delete the entire `pdf-extract` service block; it built the now-deleted `Dockerfile.extract-service`)
- Create: `.gitmodules` entry for `services/pdf2w-extract/` (this step has an **external prerequisite** — see below)
- Modify: `AGENTS.md`'s repo-layout tree and script list (delete the `extract:dev` line, delete the `Dockerfile.extract-service`/`docker-compose.yml` `pdf-extract` references, add `services/pdf2w-extract/` and `PDF2W_SERVICE_URL`)

**External prerequisite (not a TypeScript task):** this step assumes `https://github.com/pdf-triage-org/pdf-triage-pdf2w` already has a working Go gateway answering `POST /convert` per the contract Task 2's client expects. If that repo doesn't exist yet or its contract doesn't match, **stop here and build/verify that first** — everything from Task 1 onward can be developed and unit-tested against a mocked `fetch` (as every task above already does), but nothing in this app can be run end-to-end against a real service until the submodule is real. Treat that submodule's own implementation as a separate, parallel-track piece of work, not a task this plan can hand to a TypeScript-focused engineer.

- [ ] **Step 1: Add the submodule (once the sibling repo is ready)**

```bash
git submodule add https://github.com/pdf-triage-org/pdf-triage-pdf2w.git services/pdf2w-extract
```

- [ ] **Step 2: Replace the `docker-compose.yml` service block**

Delete the entire `pdf-extract:` service (the whole file's current content is this one block) and replace it with a block that builds `services/pdf2w-extract/` — the exact `build.context`/`dockerfile`/`ports`/`healthcheck` shape depends on what that submodule's own Dockerfile expects, so mirror its own README/docker-compose (if it ships one) rather than guessing the shape here. At minimum:

```yaml
services:
  pdf2w-extract:
    build:
      context: services/pdf2w-extract
    image: pdf-triage/pdf2w-extract:latest
    container_name: pdf-triage-pdf2w-extract
    restart: unless-stopped
    ports:
      - "3985:3985"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3985/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

- [ ] **Step 3: Verify with the real service**

Run: `docker compose up -d --build && curl -f http://127.0.0.1:3985/health`
Expected: `200`. Then set `PDF2W_SERVICE_URL=http://127.0.0.1:3985` in `.env` and run one real triage scan against a test PDF in `__raws` to confirm the whole path works end-to-end — this is the only step in the entire plan that needs a live service; everything else was proven with mocks.

- [ ] **Step 4: Commit**

```bash
git add .gitmodules services/pdf2w-extract docker-compose.yml
git commit -m "feat(extraction): wire pdf2w-extract submodule + docker-compose service"
```

---

## Task 9: Docs handoff

This app's own convention (per `AGENTS.md`) is that docs updates following an architecture change are the **docs-curator** agent's job, not hand-edited inline by whichever agent implemented the change. Do not write the doc content yourself as part of this plan.

- [ ] **Step 1: Invoke docs-curator**

After Tasks 1-8 are merged, invoke the `docs-curator` agent with: "The pdf2w extraction swap (docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md, docs/superpowers/plans/2026-09-17-pdf2w-extraction-swap-plan.md) is implemented and merged. Rewrite `docs/knowledge/docling-extract-layer.md` and `docs/knowledge/pdf-extract-service.md` (both now describe deleted architecture), update the now-stale parts of `docs/knowledge/service-split-plan.md`, update `docs/knowledge/architecture.md`'s module map and 'OCR engine fallback and its cost' section, update `docs/knowledge/environment.md`'s env var table, and add a CHANGELOG.md entry."

---

## Roadmap sketch: future Go/Rust slices (NOT a committed plan)

Per `project-go-rust-migration` memory: the user's direction is "on futur all code must use go and rust," applied one deliberately scoped slice at a time rather than a big-bang rewrite — this section is a candidate list for conversation, not a schedule, and none of it should be started without its own scoped design doc first (mirroring how this slice started as `2026-09-17-pdf2w-extraction-swap-design.md` before this plan existed).

Candidate next slices, roughly ordered by how cleanly they separate from the rest of the TypeScript app (per `docs/knowledge/architecture.md`'s module map and ownership table):

1. **Vision pipeline (`domain/flood-crop.ts`, `image-adjust.ts`, `exif-orientation.ts`, `infrastructure/image-processor.ts`, `vision-client.ts`, `crop-detector.ts`)** — mostly pure geometry/pixel math already isolated behind `image-to-pdf.ts`'s step functions, similar shape to the extraction seam this plan just replaced. Golden Rule 17's invariants (never re-apply EXIF orientation, never reintroduce the inverted texture gate) would need to travel with whatever replaces it — they are hard-won correctness fixes, not incidental TypeScript.
2. **SQLite + FTS5 layer (`infrastructure/db/database.ts`, `json-registry.ts`)** — self-contained behind a narrow CRUD interface already (see the ownership table's `db-registry-keeper` boundary), but higher risk: it's the record of truth, and Rust's SQLite ecosystem (`rusqlite`) is mature enough that this is plausible, not experimental.
3. **Classification engine (`domain/classification.ts`, `prompt.ts`, `classification-resolution.ts`)** — the highest-value but highest-risk slice: deep domain logic (Golden Rules 6/7/19) with the most institutional knowledge encoded in comments and tests. Would need the most careful parity testing of any slice attempted so far (mirroring the byte-parity approach `service-split-plan.md` already used for Service A).
4. **The Express/SSE web server (`infrastructure/http/web-server.ts`)** — largest single file, most callers, most operational risk (SSE broadcast semantics, the 10s auto-watcher, port-takeover logic in `pid-lock.ts`); almost certainly the last slice, once enough of the domain/application layers it calls into have already moved.

None of these should be scheduled here — each needs its own "why now, what's in/out of scope, what's the target contract" design doc, produced the same way this slice's design doc was, before any implementation plan like this one gets written for it.
