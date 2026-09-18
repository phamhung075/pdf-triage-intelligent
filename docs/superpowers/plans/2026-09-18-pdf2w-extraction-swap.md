# pdf2w Extraction Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This project's own dispatch model applies on top of the sub-skill above:** every task below is
> sized to be handed to a DeepSeek Harness worker per
> [`.agents/skills/pdf-triage-dispatch/SKILL.md`](../../../.agents/skills/pdf-triage-dispatch/SKILL.md).
> Read that skill (and `deepseek-offload/SKILL.md`) before dispatching. Never `npm run dev`/`npm start`
> from a worker or this session. Workers do not commit; the orchestrator reviews and commits.

**Goal:** Replace PaddleOCR/the Docling sidecar with the self-hosted `markdown-extract-service`
(pdf2w) for all PDF/photo text extraction, and port `computeCanonicalPath` out of
`domain/taxonomy.ts` into a new Go service (`pdf-triage-pdf2w`), called by the TypeScript app over
HTTP.

**Architecture:** Two new required (no-fallback) HTTP dependencies for the TS app: (1) the
existing, unmodified, self-hosted `markdown-extract-service` for extraction, called from a new
`pdf2w-remote.ts` client; (2) a brand-new Go microservice in a submodule, exposing only
`POST /canonical-path`, called from a new `canonical-path-remote.ts` client. Everything else in
`taxonomy.ts` and the rest of the pipeline (classification, scan loop, SSE, SQLite) stays
TypeScript, unchanged.

**Tech Stack:** TypeScript/Node/Express (existing), Go 1.22+ (new submodule), Vitest, `go test`.

**Design doc:** `docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md` — read it
first; this plan implements it exactly. Do not re-derive scope decisions already made there.

## Global Constraints

- Golden Rule 0 (Think First): read the exact file/line ranges cited in each task before editing.
- Golden Rule 1: scan scope stays `__raws` only — untouched by this work.
- Golden Rule 3 (`< 10` char guard) and Golden Rule 4 (strict no-subcategory fail guard): both
  guards run on whatever `extractPDFContent()`/`computeCanonicalPath` return — their call sites
  change, their pass/fail semantics do not. Do not weaken either guard while rewiring callers.
- Golden Rule 9: triage stays sequential, one file at a time, with the existing
  `setTimeout(resolve, 50)` yield between files — an HTTP call per file is compatible with this;
  do not `Promise.all` anything.
- Golden Rule 16: no DI container, no aggregate classes, no event bus. The Go service is a single
  small `net/http` handler calling one pure function — nothing more.
- **Never run `npm run dev`/`npm start`.** The user runs the server themselves, in their own
  terminal, to verify each task manually if they choose.
- **No personal data in committed files** — none of this work touches `.prompts.private.json` or
  `.categories.private.json`; do not create test fixtures containing real names/entities.
- Every task ends with `npm run typecheck && npm test` green (TS tasks) or `go test ./...` green
  (Go tasks) before commit.

---

### Task 1: Go submodule scaffold + `computeCanonicalPath` port (TDD)

**Files:**
- Create (in a local working copy that becomes the `pdf-triage-pdf2w` repo, then pushed to
  `https://github.com/phamhung075/pdf-triage-pdf2w` and added as a git submodule at
  `services/pdf-triage-pdf2w/` in Task 2): `go.mod`, `canonicalpath/canonicalpath.go`,
  `canonicalpath/canonicalpath_test.go`

**Interfaces:**
- Produces: `func ComputeCanonicalPath(originalPath, category, outputRootDir string, subcategory, dateStr, title *string) string` — Task 3's HTTP handler calls this directly.

- [ ] **Step 1: Write the failing Go tests**, porting the five `computeCanonicalPath` cases from
  `src/domain/taxonomy.test.ts` verbatim (same inputs, same expected outputs — this is the
  acceptance bar per the design doc's Testing section):

```go
// canonicalpath/canonicalpath_test.go
package canonicalpath

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func strp(s string) *string { return &s }

func TestComputeCanonicalPath(t *testing.T) {
	root := filepath.Join("C:", "test-archive")

	t.Run("builds category/subcategory/year/filename under outputRootDir", func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\facture.pdf`, "invoices", root, strp("sfr"), strp("2024-05-12"), nil)
		want := filepath.Join(root, "invoices", "sfr", "2024", "facture.pdf")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("falls back to the current year when dateStr has no 20xx year", func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\facture.pdf`, "invoices", root, strp("sfr"), nil, nil)
		year := strconv.Itoa(time.Now().Year())
		want := filepath.Join(root, "invoices", "sfr", year, "facture.pdf")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run(`coerces a bare-year subcategory to "general" instead of nesting under a year folder`, func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\doc.pdf`, "administrative", root, strp("2023"), strp("2024-01-01"), nil)
		want := filepath.Join(root, "administrative", "general", "2024", "doc.pdf")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run(`defaults an empty category to "other" and empty subcategory to "general"`, func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\doc.pdf`, "", root, strp(""), strp("2024-01-01"), nil)
		want := filepath.Join(root, "other", "general", "2024", "doc.pdf")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("splits a subcategory containing a slash into nested path segments", func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\doc.pdf`, "invoices", root, strp("foo/bar"), strp("2024-01-01"), nil)
		want := filepath.Join(root, "invoices", "foo", "bar", "2024", "doc.pdf")
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd canonicalpath && go test ./... -run TestComputeCanonicalPath -v`
Expected: FAIL — `ComputeCanonicalPath` undefined.

- [ ] **Step 3: Port the implementation**, translating `src/domain/taxonomy.ts` lines 128-258
  (`formatEntitySlug`, `generateIntelligentFilename`, `sanitizePathSegment`,
  `computeCanonicalPath`) function-for-function. Keep the same forbidden-subcategory-adjacent
  "year → general" coercion, the same "empty category → other / empty subcategory → general"
  defaults, and the same slash-splitting for nested subcategories. The filename-generation logic
  (`generateIntelligentFilename`, which depends on `isGenericFilename`) is in scope too, since
  `computeCanonicalPath` calls it — port it alongside, self-contained inside this package (it is
  not called from anywhere else in the TS app outside `taxonomy.ts` today, so no separate TS export
  needs to keep working):

```go
// canonicalpath/canonicalpath.go
package canonicalpath

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var yearRe = regexp.MustCompile(`^\d{4}$`)

func isYearString(s string) bool {
	return yearRe.MatchString(strings.TrimSpace(s))
}

// sanitizePathSegment mirrors taxonomy.ts's function of the same name: collapse anything that
// is not a slug character to '_', neutralizing '..'/'.'/drive prefixes while leaving real slugs
// byte-identical. A category or subcategory can arrive here from an unvalidated HTTP body or MCP
// call, so this must run on every segment before it is joined into a filesystem path.
func sanitizePathSegment(segment, fallback string) string {
	s := strings.ToLower(strings.TrimSpace(stripAccents(segment)))
	s = regexp.MustCompile(`[^a-z0-9_-]+`).ReplaceAllString(s, "_")
	s = regexp.MustCompile(`^[_.-]+|[_.-]+$`).ReplaceAllString(s, "")
	if s == "" {
		return fallback
	}
	return s
}

// ComputeCanonicalPath ports src/domain/taxonomy.ts's computeCanonicalPath function-for-function.
// dateStr and title are optional (nil = not provided), matching the TS function's optional
// parameters.
func ComputeCanonicalPath(originalPath, category, outputRootDir string, subcategory, dateStr, title *string) string {
	originalFile := filepath.Base(originalPath)
	file := generateIntelligentFilename(originalFile, deref(title), category, deref(subcategory), deref(dateStr))

	cleanCat := "other"
	if strings.TrimSpace(category) != "" {
		cleanCat = strings.ToLower(strings.TrimSpace(category))
	}
	cleanSub := "general"
	if subcategory != nil && strings.TrimSpace(*subcategory) != "" {
		cleanSub = strings.ToLower(strings.TrimSpace(*subcategory))
	}
	if isYearString(cleanSub) {
		cleanSub = "general"
	}

	yearStr := strconv.Itoa(time.Now().Year())
	if dateStr != nil && len(*dateStr) >= 4 {
		if m := regexp.MustCompile(`\b(20\d{2})\b`).FindStringSubmatch(*dateStr); m != nil {
			yearStr = m[1]
		}
	}

	safeCat := sanitizePathSegment(cleanCat, "other")
	var subParts []string
	for _, part := range strings.FieldsFunc(cleanSub, func(r rune) bool { return r == '/' || r == '\\' }) {
		if sp := sanitizePathSegment(part, "general"); sp != "" {
			subParts = append(subParts, sp)
		}
	}

	segments := append([]string{outputRootDir, safeCat}, subParts...)
	segments = append(segments, yearStr, file)
	return filepath.Join(segments...)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
```

  `generateIntelligentFilename`, `isGenericFilename`, `formatEntitySlug`, and `stripAccents` also
  need porting (same file/package) — translate them directly from `taxonomy.ts` lines 104-202,
  preserving every regex and the CamelCase title-slugging behavior exactly; there is no shortcut
  here, the five tests above only exercise the case where `title` is absent (the common
  triage-scan path — Ollama's `titre` field is frequently empty), so also add a sixth test case
  covering `title` non-empty against a generic source filename before considering this step done:

```go
	t.Run("renames a generic filename using the title when provided", func(t *testing.T) {
		got := ComputeCanonicalPath(`C:\raws\img001.jpg`, "invoices", root, strp("sfr"), strp("2024-05-12"), strp("Facture Mai"))
		if !strings.Contains(got, "2024-05-12_Sfr_Facture") {
			t.Fatalf("expected an intelligent filename containing '2024-05-12_Sfr_Facture', got %q", got)
		}
	})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd canonicalpath && go test ./... -v`
Expected: PASS, all 6 cases.

- [ ] **Step 5: Add `go.mod`**

```
module github.com/phamhung075/pdf-triage-pdf2w

go 1.22
```

- [ ] **Step 6: Commit** (in the new repo's own working copy, not yet in pdf-triage)

```bash
git init
git add go.mod canonicalpath/
git commit -m "feat: port computeCanonicalPath from pdf-triage's taxonomy.ts"
git remote add origin https://github.com/phamhung075/pdf-triage-pdf2w.git
git push -u origin main
```

---

### Task 2: HTTP server for the Go service + submodule wiring into pdf-triage

**Files:**
- Create (same repo as Task 1): `cmd/server/main.go`, `cmd/server/main_test.go`
- Modify (pdf-triage repo): `.gitmodules` (new), add `services/pdf-triage-pdf2w/` submodule,
  `docker-compose.yml`

**Interfaces:**
- Consumes: `canonicalpath.ComputeCanonicalPath` from Task 1.
- Produces: `GET /health` → `{"status":"ok","service":"pdf-triage-pdf2w"}`; `POST /canonical-path`
  with body `{"originalPath":string,"category":string,"outputRootDir":string,"subcategory":string|null,"dateStr":string|null,"title":string|null}`
  → `{"canonicalPath":string}` — Task 4's TS client depends on this exact request/response shape.

- [ ] **Step 1: Write the failing HTTP test**

```go
// cmd/server/main_test.go
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCanonicalPathHandler(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"originalPath":  `C:\raws\facture.pdf`,
		"category":      "invoices",
		"outputRootDir": `C:\test-archive`,
		"subcategory":   "sfr",
		"dateStr":       "2024-05-12",
		"title":         nil,
	})
	req := httptest.NewRequest(http.MethodPost, "/canonical-path", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	canonicalPathHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	want := `C:\test-archive\invoices\sfr\2024\facture.pdf`
	if resp["canonicalPath"] != want {
		t.Fatalf("got %q, want %q", resp["canonicalPath"], want)
	}
}

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	healthHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./cmd/server/... -v`
Expected: FAIL — `canonicalPathHandler`/`healthHandler` undefined.

- [ ] **Step 3: Implement the server**

```go
// cmd/server/main.go
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/phamhung075/pdf-triage-pdf2w/canonicalpath"
)

type canonicalPathRequest struct {
	OriginalPath  string  `json:"originalPath"`
	Category      string  `json:"category"`
	OutputRootDir string  `json:"outputRootDir"`
	Subcategory   *string `json:"subcategory"`
	DateStr       *string `json:"dateStr"`
	Title         *string `json:"title"`
}

func canonicalPathHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req canonicalPathRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.OriginalPath == "" || req.OutputRootDir == "" {
		http.Error(w, "originalPath and outputRootDir are required", http.StatusBadRequest)
		return
	}
	result := canonicalpath.ComputeCanonicalPath(req.OriginalPath, req.Category, req.OutputRootDir, req.Subcategory, req.DateStr, req.Title)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"canonicalPath": result})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "pdf-triage-pdf2w"})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3985"
	}
	http.HandleFunc("/canonical-path", canonicalPathHandler)
	http.HandleFunc("/health", healthHandler)
	log.Printf("pdf-triage-pdf2w listening on :%s", port)
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, nil))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./... -v`
Expected: PASS.

- [ ] **Step 5: Commit and push** (`pdf-triage-pdf2w` repo)

```bash
git add cmd/
git commit -m "feat: HTTP server exposing POST /canonical-path"
git push
```

- [ ] **Step 6: Add the submodule to pdf-triage**

Run (in the `pdf-triage` repo):
```bash
git submodule add https://github.com/phamhung075/pdf-triage-pdf2w.git services/pdf-triage-pdf2w
```

- [ ] **Step 7: Add a Dockerfile to the submodule** so pdf-triage's compose can build it —
  create `Dockerfile` in the `pdf-triage-pdf2w` repo:

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod ./
COPY canonicalpath/ ./canonicalpath/
COPY cmd/ ./cmd/
RUN go build -o /pdf-triage-pdf2w ./cmd/server

FROM alpine:3.19
COPY --from=build /pdf-triage-pdf2w /pdf-triage-pdf2w
EXPOSE 3985
ENTRYPOINT ["/pdf-triage-pdf2w"]
```

Commit and push this to the `pdf-triage-pdf2w` repo, then update the submodule pointer in
pdf-triage:
```bash
cd services/pdf-triage-pdf2w && git add Dockerfile && git commit -m "chore: add Dockerfile" && git push
cd ../.. && git add services/pdf-triage-pdf2w && git commit -m "chore: pin pdf-triage-pdf2w submodule to latest"
```

- [ ] **Step 8: Add the service to `docker-compose.yml`** — append this block to the `services:`
  section (mirroring the existing `pdf-extract` block's shape):

```yaml
  pdf-triage-pdf2w:
    build:
      context: ./services/pdf-triage-pdf2w
    image: pdf-triage/pdf-triage-pdf2w:latest
    container_name: pdf-triage-pdf2w
    restart: unless-stopped
    ports:
      - "3985:3985"
    environment:
      PORT: "3985"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3985/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

- [ ] **Step 9: Commit the submodule + compose wiring** (pdf-triage repo)

```bash
git add .gitmodules services/pdf-triage-pdf2w docker-compose.yml
git commit -m "feat: add pdf-triage-pdf2w submodule (Go canonical-path service)"
```

---

### Task 3: `canonical-path-remote.ts` TS client

**Files:**
- Create: `src/infrastructure/canonical-path-remote.ts`
- Create: `src/infrastructure/canonical-path-remote.test.ts`
- Modify: `src/infrastructure/settings.ts` (add `CANONICAL_PATH_SERVICE_URL` / `_TIMEOUT_MS`)
- Modify: `.env.example` (document the new var)

**Interfaces:**
- Consumes: nothing new (plain `fetch`, matching `docling-remote.ts`'s pattern).
- Produces: `export async function computeCanonicalPathRemote(originalPath: string, category: string, outputRootDir: string, subcategory?: string, dateStr?: string, title?: string): Promise<string>` — Task 5 imports this exact signature.

- [ ] **Step 1: Write the failing test**

```typescript
// src/infrastructure/canonical-path-remote.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeCanonicalPathRemote } from './canonical-path-remote.js';
import { CONFIG } from './settings.js';

describe('computeCanonicalPathRemote', () => {
  const originalUrl = CONFIG.CANONICAL_PATH_SERVICE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = 'http://127.0.0.1:3985';
  });

  afterEach(() => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = originalUrl;
    global.fetch = originalFetch;
  });

  it('posts the parameters and returns canonicalPath from the response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ canonicalPath: 'C:\\archive\\invoices\\sfr\\2024\\facture.pdf' }),
    }) as any;

    const result = await computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive', 'sfr', '2024-05-12');

    expect(result).toBe('C:\\archive\\invoices\\sfr\\2024\\facture.pdf');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3985/canonical-path',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when the service is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    await expect(
      computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive')
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when CANONICAL_PATH_SERVICE_URL is not configured', async () => {
    CONFIG.CANONICAL_PATH_SERVICE_URL = '';
    await expect(
      computeCanonicalPathRemote('C:\\raws\\facture.pdf', 'invoices', 'C:\\archive')
    ).rejects.toThrow('CANONICAL_PATH_SERVICE_URL is not configured');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- canonical-path-remote`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add config** — in `src/infrastructure/settings.ts`, immediately after the
  `DOCLING_SERVICE_TIMEOUT_MS` block (around line 238), add:

```typescript
  // ---- Canonical-path service (Go, pdf-triage-pdf2w submodule) ------------------------------
  // Required, not optional-with-fallback: relocalizeFileIfNeeded() calls this for every file
  // organized after classification. Unreachable -> hard error (FILE_FAILED), matching the
  // "no local OCR/no local canonical-path fallback" decision in the pdf2w extraction swap design
  // (docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md).
  CANONICAL_PATH_SERVICE_URL: (process.env.CANONICAL_PATH_SERVICE_URL || '').trim(),
  CANONICAL_PATH_SERVICE_TIMEOUT_MS: (() => {
    const raw = parseInt(process.env.CANONICAL_PATH_SERVICE_TIMEOUT_MS || '0', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })(),
```

- [ ] **Step 4: Implement the client**

```typescript
// src/infrastructure/canonical-path-remote.ts
import { CONFIG } from './settings.js';

/**
 * HTTP client for the pdf-triage-pdf2w Go service's POST /canonical-path (see
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md). Required, not
 * optional-with-fallback: the caller (relocalize-document.ts) treats any rejection as a hard
 * failure for that file, matching the design's "no in-process TypeScript fallback" decision.
 */
export async function computeCanonicalPathRemote(
  originalPath: string,
  category: string,
  outputRootDir: string,
  subcategory?: string,
  dateStr?: string,
  title?: string
): Promise<string> {
  if (!CONFIG.CANONICAL_PATH_SERVICE_URL) {
    throw new Error('CANONICAL_PATH_SERVICE_URL is not configured');
  }
  const baseUrl = CONFIG.CANONICAL_PATH_SERVICE_URL.replace(/\/+$/, '');
  const timeoutMs = CONFIG.CANONICAL_PATH_SERVICE_TIMEOUT_MS;

  const res = await fetch(`${baseUrl}/canonical-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      originalPath,
      category,
      outputRootDir,
      subcategory: subcategory ?? null,
      dateStr: dateStr ?? null,
      title: title ?? null,
    }),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!res.ok) {
    throw new Error(`pdf-triage-pdf2w service returned ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  if (typeof data?.canonicalPath !== 'string') {
    throw new Error('pdf-triage-pdf2w service returned an unexpected response shape (missing canonicalPath)');
  }
  return data.canonicalPath;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- canonical-path-remote`
Expected: PASS.

- [ ] **Step 6: Document the env var** — add to `.env.example`, near the other service URLs:

```dotenv
# Go canonical-path service (services/pdf-triage-pdf2w submodule). Required — no fallback.
CANONICAL_PATH_SERVICE_URL=http://127.0.0.1:3985
# CANONICAL_PATH_SERVICE_TIMEOUT_MS=0
```

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/canonical-path-remote.ts src/infrastructure/canonical-path-remote.test.ts src/infrastructure/settings.ts .env.example
git commit -m "feat: add canonical-path-remote.ts client for the pdf-triage-pdf2w service"
```

---

### Task 4: Wire `relocalize-document.ts` to the remote canonical-path call

**Files:**
- Modify: `src/application/relocalize-document.ts:42-53` (`relocalizeFileIfNeeded`)
- Modify: every caller of `relocalizeFileIfNeeded` to `await` it: `src/application/triage-scan.ts` (the `relocalizeFileIfNeeded(...)` call in the post-classification move, currently not awaited because the function was sync), `src/infrastructure/http/web-server.ts` (the manual Relocalize route, if it calls this function directly — confirm with `grep -n relocalizeFileIfNeeded src/infrastructure/http/web-server.ts` before editing)
- Modify: `src/domain/taxonomy.ts` — remove `computeCanonicalPath`, `generateIntelligentFilename`, `formatEntitySlug`, `isGenericFilename`, and the private `sanitizePathSegment` (lines 104-259 per the current file)
- Modify: `src/domain/taxonomy.test.ts` — remove the `computeCanonicalPath` describe block (lines 53-79); leave every other describe block untouched
- Modify: `src/application/relocalize-document.test.ts` — update any test that calls `relocalizeFileIfNeeded` synchronously to `await` it and mock `computeCanonicalPathRemote`

**Interfaces:**
- Consumes: `computeCanonicalPathRemote` from Task 3.
- Produces: `relocalizeFileIfNeeded` becomes `async (filePath, category, subcategory?, dateStr?, title?) => Promise<{ newPath: string; moved: boolean }>` — same shape as today, wrapped in a Promise. No other function in this task changes signature.

- [ ] **Step 1: Update the failing/existing tests first** — in
  `relocalize-document.test.ts`, find every call site of `relocalizeFileIfNeeded(...)` and change
  it to `await relocalizeFileIfNeeded(...)`, and mock `canonical-path-remote.js` so the existing
  assertions (which currently expect specific canonical paths from the in-process
  `computeCanonicalPath`) keep passing against the mocked remote response:

```typescript
vi.mock('../infrastructure/canonical-path-remote.js', () => ({
  computeCanonicalPathRemote: vi.fn(async (originalPath, category, outputRootDir, subcategory, dateStr, title) => {
    // Re-import the real logic only for this test double, so existing assertions about exact
    // paths keep working without duplicating computeCanonicalPath's rules in the mock by hand.
    const { computeCanonicalPath } = await vi.importActual<typeof import('../domain/taxonomy.js')>('../domain/taxonomy.js');
    return computeCanonicalPath(originalPath, category, outputRootDir, subcategory, dateStr, title);
  }),
}));
```

  Leave this mock in place only until Step 3 removes `computeCanonicalPath` from `taxonomy.js` —
  at that point, replace the mock body with literal expected strings per test case instead of
  calling the now-deleted function.

- [ ] **Step 2: Run to verify current tests still describe the intended behavior**

Run: `npm test -- relocalize-document`
Expected: FAIL initially (function not yet async) — this confirms the tests exercise the change
before it's made.

- [ ] **Step 3: Update `relocalizeFileIfNeeded`** — replace the `computeCanonicalPath` import and
  call in `src/application/relocalize-document.ts`:

```typescript
// before (line 4 and line 54):
// import { computeCanonicalPath, isForbiddenSubcategory } from '../domain/taxonomy.js';
// const targetPath = computeCanonicalPath(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr, title);

// after:
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { computeCanonicalPathRemote } from '../infrastructure/canonical-path-remote.js';

export async function relocalizeFileIfNeeded(
  filePath: string,
  category: string,
  subcategory?: string,
  dateStr?: string,
  title?: string
): Promise<{ newPath: string; moved: boolean }> {
  const originalFilename = path.basename(filePath);
  const targetPath = await computeCanonicalPathRemote(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr, title);
  // ...rest of the function body is unchanged...
```

- [ ] **Step 4: Update every caller to `await`** — `grep -n "relocalizeFileIfNeeded(" src/application/triage-scan.ts src/infrastructure/http/web-server.ts src/application/repair-registry.ts` and add `await` at each call site found (the surrounding function is already `async` in every current caller — confirm this with the same grep before assuming it).

- [ ] **Step 5: Remove the ported functions from `taxonomy.ts`** — delete
  `generateIntelligentFilename`, `formatEntitySlug`, `isGenericFilename`, `sanitizePathSegment`,
  and `computeCanonicalPath` (the block from `formatEntitySlug` through the end of
  `computeCanonicalPath`, roughly lines 104-259 of the current file). Leave `isPathInsideDir`,
  `isYearString`, `detectFileType`, `isForbiddenSubcategory`, `findCanonicalCategoryForSubcategory`,
  `mergeSubcategoryInTaxonomy` untouched.

- [ ] **Step 6: Remove the now-dead test block** — delete the `describe('computeCanonicalPath', ...)`
  block from `src/domain/taxonomy.test.ts` (lines 53-79) and drop `computeCanonicalPath` from its
  import line at the top of the file.

- [ ] **Step 7: Finalize the mock in `relocalize-document.test.ts`** — replace the
  `vi.importActual` indirection from Step 1 with literal expected canonical paths per test case
  (copy the expected string each existing assertion already checks), since `computeCanonicalPath`
  no longer exists in `taxonomy.ts` to import.

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no references to the deleted functions remain anywhere (`grep -rn "computeCanonicalPath\|generateIntelligentFilename" src --include="*.ts"` should only match `canonical-path-remote.ts` and its test).

- [ ] **Step 9: Commit**

```bash
git add src/application/relocalize-document.ts src/application/relocalize-document.test.ts src/application/triage-scan.ts src/infrastructure/http/web-server.ts src/domain/taxonomy.ts src/domain/taxonomy.test.ts
git commit -m "feat: relocalizeFileIfNeeded calls the pdf-triage-pdf2w canonical-path service"
```

---

### Task 5: `pdf2w-remote.ts` extraction client + routing swap

**Files:**
- Create: `src/infrastructure/pdf2w-remote.ts`, `src/infrastructure/pdf2w-remote.test.ts`
- Modify: `src/infrastructure/settings.ts` (add `PDF2W_SERVICE_URL` / `_TIMEOUT_MS`, remove `DOCLING_SERVICE_*` and `PDF_EXTRACT_SERVICE_*`/`EXTRACT_SERVICE_*` blocks)
- Modify: `src/infrastructure/pdf-extractor.ts` (replace `extractPDFContent()` body and all Docling/remote-extract-service routing, lines 670-798 approximately, plus the local extraction fallback code and the PaddleOCR import at the top)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export async function extractPdf2wContent(filePath: string): Promise<ExtractedPDF>` where `ExtractedPDF` is the existing interface in `pdf-extractor.ts` (unchanged shape, `docling_markdown` field renamed to `pdf2w_markdown` — grep every reader of `docling_markdown` in `classify-document.ts` before renaming, so Step C's Markdown-skip logic keeps working under the new field name).

- [ ] **Step 1: Write the failing test**

```typescript
// src/infrastructure/pdf2w-remote.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { extractPdf2wContent } from './pdf2w-remote.js';
import { CONFIG } from './settings.js';

describe('extractPdf2wContent', () => {
  const originalUrl = CONFIG.PDF2W_SERVICE_URL;
  const originalFetch = global.fetch;
  const tmpFile = 'test-fixture-pdf2w.pdf';

  beforeEach(() => {
    CONFIG.PDF2W_SERVICE_URL = 'http://127.0.0.1:3984';
    fs.writeFileSync(tmpFile, '%PDF-1.4 fake content for hashing');
  });

  afterEach(() => {
    CONFIG.PDF2W_SERVICE_URL = originalUrl;
    global.fetch = originalFetch;
    fs.unlinkSync(tmpFile);
  });

  it('posts the file and returns the extraction result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: '# Facture', text: 'Facture SFR', numpages: 1, checksum: 'abc' }),
    }) as any;

    const result = await extractPdf2wContent(tmpFile);

    expect(result.raw_text).toBe('Facture SFR');
    expect(result.pdf2w_markdown).toBe('# Facture');
    expect(result.numpages).toBe(1);
  });

  it('throws when the service is unreachable (no fallback)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    await expect(extractPdf2wContent(tmpFile)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when PDF2W_SERVICE_URL is not configured', async () => {
    CONFIG.PDF2W_SERVICE_URL = '';
    await expect(extractPdf2wContent(tmpFile)).rejects.toThrow('PDF2W_SERVICE_URL is not configured');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pdf2w-remote`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add config** — replace the entire `PDF_EXTRACT_SERVICE_*`/`EXTRACT_SERVICE_*`
  block (settings.ts lines ~193-222) and the entire `DOCLING_SERVICE_*` block (lines ~224-238)
  with:

```typescript
  // ---- pdf2w extraction service (self-hosted markdown-extract-service) ----------------------
  // Required, not optional-with-fallback: extractPDFContent() delegates ALL PDF/photo-derived-PDF
  // extraction here. Unreachable -> hard error (FILE_FAILED). Point this at your own self-hosted
  // markdown-extract-service instance (see docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md)
  // — pdf-triage never calls app.pdf2w.com and never writes extraction code of its own.
  PDF2W_SERVICE_URL: (process.env.PDF2W_SERVICE_URL || '').trim(),
  PDF2W_SERVICE_TIMEOUT_MS: (() => {
    const raw = parseInt(process.env.PDF2W_SERVICE_TIMEOUT_MS || '0', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })(),
```

  Also delete the `PADDLEOCR_HOST` / `PADDLEOCR_SPAWN_CMD` lines (~164-165) — Task 7 removes their
  only consumer, but deleting the dead config here now avoids a dangling reference in between
  tasks.

- [ ] **Step 4: Implement the client**, modeled directly on `docling-remote.ts` (read it first —
  same file, same shape, minus the fallback-vs-required branching since this client is always the
  only path):

```typescript
// src/infrastructure/pdf2w-remote.ts
import fs from 'fs';
import path from 'path';
import { CONFIG } from './settings.js';

export interface Pdf2wExtractResult {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
  pdf2w_markdown: string;
}

/**
 * HTTP client for the self-hosted markdown-extract-service (pdf2w). Required, not
 * optional-with-fallback: the caller (extractPDFContent in pdf-extractor.ts) treats any failure
 * as a hard error for that file — there is no in-process extraction left to fall back to. See
 * docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md.
 */
export async function extractPdf2wContent(filePath: string): Promise<Pdf2wExtractResult> {
  if (!CONFIG.PDF2W_SERVICE_URL) {
    throw new Error('PDF2W_SERVICE_URL is not configured');
  }
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
    throw new Error(`pdf2w service returned ${res.status} ${res.statusText} for '${path.basename(filePath)}'`);
  }

  const data: any = await res.json();
  if (typeof data?.markdown !== 'string') {
    throw new Error('pdf2w service returned an unexpected response shape (missing markdown)');
  }

  return {
    checksum: typeof data.checksum === 'string' ? data.checksum : '',
    raw_text: typeof data.text === 'string' ? data.text : data.markdown,
    numpages: typeof data.numpages === 'number' && data.numpages >= 1 ? data.numpages : 1,
    info: data.info && typeof data.info === 'object' ? data.info : {},
    pdf2w_markdown: data.markdown,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- pdf2w-remote`
Expected: PASS.

- [ ] **Step 6: Replace `extractPDFContent()`'s routing in `pdf-extractor.ts`** — first run
  `grep -n "docling_markdown" src/application/classify-document.ts` to find every reader, then
  rename each to `pdf2w_markdown`. Then replace the imports at the top of `pdf-extractor.ts`:

```typescript
// remove:
// import { paddleOcrRecognize } from './paddleocr-client.js';
// import { extractPDFContentRemote } from './pdf-extract-remote.js';
// import { isDoclingExtractionConfigured, isDoclingExtractionRequired, extractDoclingContent } from './docling-remote.js';
// import { assessDoclingMarkdown } from '../domain/docling-quality.js';

// add:
import { extractPdf2wContent } from './pdf2w-remote.js';
```

  Update the `ExtractedPDF` interface's `docling_markdown?: string` field to `pdf2w_markdown?: string`.
  Replace the entire block from `tryDoclingExtraction` through the end of `extractPDFContent()`
  (lines ~693-798, whatever remains after locating the exact current boundaries with
  `grep -n "^export async function extractPDFContent\|^async function tryDoclingExtraction\|^export function isRemoteExtractionConfigured" src/infrastructure/pdf-extractor.ts`) with:

```typescript
export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  const filename = path.basename(filePath);
  const pdf2w = await extractPdf2wContent(filePath);
  logger.info('PDF_PARSER', `Extraction delegated to pdf2w (${pdf2w.raw_text.length} chars)`, { filename });
  return {
    checksum: pdf2w.checksum || crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    raw_text: cleanExtractedText(pdf2w.raw_text),
    numpages: pdf2w.numpages,
    info: pdf2w.info,
    pdf2w_markdown: pdf2w.pdf2w_markdown,
  };
}
```

  Leave `extractPDFContentLocal`'s internal helper functions that are still used elsewhere in this
  file (if any — check with `grep -n "extractPDFContentLocal\b" src/infrastructure/pdf-extractor.ts`
  for other call sites before deleting the function body; Task 7 handles the full deletion of
  everything that becomes dead code once this task lands).

- [ ] **Step 7: Add the env var to `.env.example`**

```dotenv
# Self-hosted markdown-extract-service (pdf2w). Required — no fallback, no calls to app.pdf2w.com.
PDF2W_SERVICE_URL=http://127.0.0.1:3984
# PDF2W_SERVICE_TIMEOUT_MS=0
```

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: Failures are expected here from `pdf-extractor.test.ts` and other tests referencing
the deleted routing — that cleanup is Task 7. Confirm the ONLY failures are in files Task 7
already lists for deletion/update (`pdf-extractor.test.ts`, `pdf-extractor-docling-routing.test.ts`,
`pdf-extractor-routing.test.ts`) before proceeding; anything else failing means this task's edit
touched something out of scope and must be fixed now.

- [ ] **Step 9: Commit**

```bash
git add src/infrastructure/pdf2w-remote.ts src/infrastructure/pdf2w-remote.test.ts src/infrastructure/pdf-extractor.ts src/infrastructure/settings.ts src/application/classify-document.ts .env.example
git commit -m "feat: extractPDFContent delegates to the self-hosted pdf2w service"
```

---

### Task 6: Photo pipeline — drop local OCR

**Files:**
- Modify: `src/application/convert-image-document.ts` (the function described at its own header, lines ~113 onward — read the full function before editing)
- Modify: `src/application/image-to-pdf.ts` (remove `runExtractStep` if this task's grep shows no other caller)
- Modify: `src/application/convert-image-document.test.ts`, `src/application/image-to-pdf.test.ts`, `src/application/image-to-pdf.integration.test.ts`

**Interfaces:**
- Consumes: `extractPDFContent` from Task 5 (already exported from `pdf-extractor.ts`).
- Produces: `convertImageToPdf`'s return type (`ConvertedImageDocument`) is unchanged; its
  `rawText` field is now populated by calling `extractPDFContent(pdfPath)` on the assembled PDF
  instead of carrying OCR text produced before assembly.

- [ ] **Step 1: Confirm `runExtractStep`'s only caller** —
  `grep -rn "runExtractStep" src --include="*.ts"`. If `convert-image-document.ts` is its only
  caller, it will be deleted in Step 3; if `image-to-pdf.ts`'s Vision Lab standalone diagnostic
  page (`public/test-image-to-pdf.html` via `vision-lab-server.ts`) also calls it directly, leave
  `runExtractStep` in place (the Vision Lab is a standalone diagnostic tool, out of scope for this
  swap) and only stop calling it from `convert-image-document.ts`.

- [ ] **Step 2: Update the tests first** — in `convert-image-document.test.ts`, find every
  assertion that expects OCR to run before PDF assembly (search for `runExtractStep` or
  `ocrImageBufferBothEngines` mocks) and change the expectation to: OCR is NOT called during
  conversion, and `rawText` on the returned `ConvertedImageDocument` comes from a mocked
  `extractPDFContent` call against the assembled PDF path instead.

- [ ] **Step 3: Update `convert-image-document.ts`** — remove the `runExtractStep` import and
  call from the orient→crop→enhance→**extract**→assemble sequence, so it becomes
  orient→crop→enhance→assemble; after `fs.writeFileSync`-ing the PDF (or the pdf-lib save call
  already in this function), call `extractPDFContent(pdfPath)` and use its `raw_text` as the
  function's `rawText` return value instead of the OCR step's output. Import `extractPDFContent`
  from `../infrastructure/pdf-extractor.js`.

- [ ] **Step 4: Remove `runExtractStep` from `image-to-pdf.ts`** only if Step 1 confirmed no other
  caller; otherwise leave it and only remove `convert-image-document.ts`'s call to it.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS for every test this task touches; `image-to-pdf.integration.test.ts` may need its
OCR-related assertions removed if it exercises the same removed call path — check its failures
individually rather than assuming.

- [ ] **Step 6: Commit**

```bash
git add src/application/convert-image-document.ts src/application/convert-image-document.test.ts src/application/image-to-pdf.ts src/application/image-to-pdf.test.ts src/application/image-to-pdf.integration.test.ts
git commit -m "feat: photo pipeline gets OCR text from pdf2w after PDF assembly, not before"
```

---

### Task 7: Delete PaddleOCR, Docling sidecar, and the extract-service split

**Files:**
- Delete: `paddleocr-server/` (whole directory)
- Delete: `src/infrastructure/paddleocr-client.ts`, `src/infrastructure/paddleocr-client.test.ts`
- Delete: `src/infrastructure/docling-remote.ts`
- Delete: `src/domain/docling-quality.ts`, `src/domain/docling-quality.test.ts`
- Delete: `src/extract-service/` (whole directory, including `app.test.ts`), `Dockerfile.extract-service`
- Delete: `src/infrastructure/pdf-extract-remote.ts`
- Delete: `src/infrastructure/pdf-extractor-docling-routing.test.ts`, `src/infrastructure/pdf-extractor-routing.test.ts`
- Modify: `docker-compose.yml` (remove the `pdf-extract` service block, keep the new `pdf-triage-pdf2w` block from Task 2)
- Modify: `package.json` (remove the `extract:dev` script)
- Modify: `.dockerignore` (check whether any rule references only the deleted `src/extract-service/`; leave rules that also apply elsewhere)
- Modify: `src/infrastructure/pdf-extractor.ts` — remove `extractPDFContentLocal` and every helper only it used (verify with `grep -n` per function name before deleting each one, since some helpers like `cleanExtractedText`'s import are still used by Task 5's new `extractPDFContent`)
- Modify: `src/infrastructure/orientation-detector.ts` — audit for PaddleOCR-only code paths (per the design doc's flagged-for-audit note); remove only what has no non-OCR consumer, confirmed via `grep -rn` before deleting
- Modify: `src/domain/ocr-layout.ts` — same audit; this file's tests (`ocr-layout.test.ts`) determine whether it has surviving non-OCR consumers

**Interfaces:** None — this task only removes dead code left over after Tasks 5 and 6 rewired
their callers. No new interface is produced.

- [ ] **Step 1: Confirm nothing outside the deletion list still imports these modules**

Run:
```bash
grep -rln "paddleocr-client\|docling-remote\|docling-quality\|pdf-extract-remote" src --include="*.ts" | grep -v -E "paddleocr-client\.(test\.)?ts$|docling-remote\.ts$|docling-quality\.(test\.)?ts$|pdf-extract-remote\.ts$"
```
Expected: empty output. If anything prints, resolve that import before deleting (it means Task 5
or 6 missed a call site).

- [ ] **Step 2: Delete the files/directories**

```bash
git rm -r paddleocr-server/
git rm src/infrastructure/paddleocr-client.ts src/infrastructure/paddleocr-client.test.ts
git rm src/infrastructure/docling-remote.ts
git rm src/domain/docling-quality.ts src/domain/docling-quality.test.ts
git rm -r src/extract-service/
git rm Dockerfile.extract-service
git rm src/infrastructure/pdf-extract-remote.ts
git rm src/infrastructure/pdf-extractor-docling-routing.test.ts src/infrastructure/pdf-extractor-routing.test.ts
```

- [ ] **Step 3: Remove the `pdf-extract` block from `docker-compose.yml`**, keeping only the
  `pdf-triage-pdf2w` block Task 2 added, and update the file's leading comment block (lines 1-19)
  to describe the new architecture instead of the old split (reference
  `docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md` instead of the now-deleted
  `docs/knowledge/pdf-extract-service.md`).

- [ ] **Step 4: Remove the `extract:dev` script from `package.json`** (`grep -n "extract:dev" package.json` to find the exact line).

- [ ] **Step 5: Audit and clean `pdf-extractor.ts`, `orientation-detector.ts`, `ocr-layout.ts`**
  per the per-file grep checks listed above — delete only functions with zero remaining callers.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. `grep -rn "paddleocr\|docling\|PDF_EXTRACT_SERVICE\|DOCLING_SERVICE" src --include="*.ts" -i` should return no matches outside comments explaining historical context (there should be none left; if any appear, remove them).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove paddleocr-server, Docling sidecar, and the extract-service split

Superseded by the self-hosted pdf2w service (pdf2w-remote.ts) and the
pdf-triage-pdf2w Go canonical-path service. See
docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md."
```

---

### Task 8: Docs flag for docs-curator (not a code task — hand off, don't hand-edit)

**Files:** none modified in this task.

- [ ] **Step 1**: after Task 7 is committed, invoke the `docs-curator` agent (per
  `docs/agents/README.md`) with: "paddleocr-server, the Docling sidecar, and the extract-service
  split were removed in favor of a self-hosted pdf2w extraction service and a new
  `pdf-triage-pdf2w` Go canonical-path service (see
  `docs/superpowers/specs/2026-09-17-pdf2w-extraction-swap-design.md`). Update `AGENTS.md`'s repo
  layout and Golden Rule anchors, delete or rewrite `docs/knowledge/docling-extract-layer.md` and
  `docs/knowledge/pdf-extract-service.md`, and update `docs/knowledge/service-split-plan.md` and
  `docs/knowledge/architecture.md` to describe the new architecture." Do not attempt this rewrite
  inline in this plan — docs-curator owns keeping `docs/` and `AGENTS.md` in sync and has its own
  playbook for it.
