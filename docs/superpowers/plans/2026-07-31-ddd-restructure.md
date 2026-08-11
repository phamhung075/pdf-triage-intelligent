# DDD Light-Layering Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` into `domain/` (pure, zero I/O), `application/` (orchestration), `infrastructure/` (I/O adapters) with no behavior change, using Phase 1's 69-test suite as the regression net.

**Architecture:** Incremental extraction — pure functions move out of `ai.service.ts`/`triage.service.ts`/`pdf.service.ts` into `src/domain/` first (their old host files shrink but keep working, importing the extracted functions back), then infrastructure pieces move out into `src/infrastructure/`, then what remains (orchestration) moves into `src/application/`. Each task updates every current importer's import line in the same commit — no re-export shims, ever. An old file is deleted only in the task that removes its last remaining piece of content.

**Tech Stack:** TypeScript, unchanged runtime deps. No new npm dependencies.

## Global Constraints

- **No behavior change.** Every Golden Rule enforcement, API route, MCP tool, SSE event, and classification decision produces identical output before and after. Any bug noticed along the way is logged, not fixed here.
- Domain functions (`src/domain/**`) perform no I/O — no `fs`, no network, no reading `CONFIG` or environment variables. They take data as parameters and return data.
- No re-export shims — when a function moves, every current importer's import line is updated in the same task. An old file is deleted the moment its last piece of content moves out.
- `npm test`, `npm run build`, and `npm run typecheck` (from `tsconfig.test.json`, added in Phase 1) stay green after every task.
- No new npm dependencies.
- `tsconfig.json` does not set `noUnusedLocals`/`noUnusedParameters` — an import that becomes unused partway through this plan (because the function it imports is about to move out in a later task on the same file) does not fail `npm run build`. Several tasks explicitly say "verify against the actual file content" before deleting an import line — trust that instruction over this plan's own before/after snippets if they ever disagree, since tracking every file's exact accumulated import state across 29 tasks by hand is exactly the kind of bookkeeping this plan's own review process (Tasks 4/11/12 self-corrections) already caught mistakes in.
- Reference spec: `docs/superpowers/specs/2026-07-31-ddd-restructure-design.md`.

---

## Task 1: `src/domain/pdf-text.ts`

**Files:**
- Create: `src/domain/pdf-text.ts`
- Modify: `src/services/pdf.service.ts` (remove `cleanExtractedText`, import it instead)

**Interfaces:**
- Produces: `cleanExtractedText(text: string, filename?: string): string` — identical behavior to today.

- [ ] **Step 1: Create `src/domain/pdf-text.ts`**

```ts
export function cleanExtractedText(text: string, filename?: string): string {
  if (!text || text.trim().length < 10) {
    return '';
  }
  return text
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 2: Remove the function from `src/services/pdf.service.ts` and import it instead**

In `src/services/pdf.service.ts`, delete the `cleanExtractedText` function definition (currently lines 14-23), and change the top of the file from:

```ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import { logger } from './logger.service.js';
```

to:

```ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import { logger } from './logger.service.js';
import { cleanExtractedText } from '../domain/pdf-text.js';
```

Everything else in `pdf.service.ts` (the `ExtractedPDF` interface, `safePdfParse`, `extractPDFContent`) stays exactly as-is — `extractPDFContent` already calls `cleanExtractedText(extracted, filename)`, which now resolves to the imported version.

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean. No test currently covers `cleanExtractedText` directly (it wasn't in Phase 1's scope) — its behavior is exercised indirectly only if something calls `extractPDFContent`, which nothing in the test suite does. This step just confirms the move doesn't break compilation or any existing test.

- [ ] **Step 4: Commit**

```bash
git add src/domain/pdf-text.ts src/services/pdf.service.ts
git commit -m "refactor: extract cleanExtractedText to src/domain/pdf-text.ts"
```

---

## Task 2: `src/domain/document.schema.ts`

**Files:**
- Create: `src/domain/document.schema.ts` (relocated from `src/schemas/document.schema.ts`)
- Delete: `src/schemas/document.schema.ts`
- Modify: `src/services/ai.service.ts`, `src/services/triage.service.ts`, `src/server/web_server.ts`, `src/mcp/server.ts` (import path only)
- Test: relocate `src/schemas/document.schema.test.ts` → `src/domain/document.schema.test.ts`

**Interfaces:**
- Produces: same exports as today (`SubcategorySchema`, `CategorySchema`, `CategoriesConfigSchema`, `EntityItemSchema`, `EntityDictionarySchema`, `SystemSettingsSchema`, `DocumentMetadataSchema`, `UpdateDocumentSchema`, `SearchQuerySchema`, and their inferred types), unchanged content, new import path `../domain/document.schema.js` for every consumer.

- [ ] **Step 1: Move the file**

```bash
git mv src/schemas/document.schema.ts src/domain/document.schema.ts
git mv src/schemas/document.schema.test.ts src/domain/document.schema.test.ts
```

The file's own content needs no changes (it has no imports of other project files, only `zod`).

- [ ] **Step 2: Update every importer's import path**

In `src/services/ai.service.ts`, change:
```ts
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../schemas/document.schema.js';
```
to:
```ts
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';
```

In `src/services/triage.service.ts` — this file doesn't currently import from `schemas/document.schema.js` directly (it uses types inferred elsewhere); skip.

In `src/server/web_server.ts`, change:
```ts
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../schemas/document.schema.js';
```
to:
```ts
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../domain/document.schema.js';
```

In `src/mcp/server.ts`, change:
```ts
import { UpdateDocumentSchema } from '../schemas/document.schema.js';
```
to:
```ts
import { UpdateDocumentSchema } from '../domain/document.schema.js';
```

- [ ] **Step 3: Remove the now-empty `src/schemas/` directory**

After the `git mv` in Step 1, `src/schemas/` has no files left in it — it's removed automatically by git once empty (no explicit action needed; verify with `ls src/schemas` that it no longer exists or is empty).

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 69 tests passing (the schema tests now run from `src/domain/document.schema.test.ts` instead of `src/schemas/document.schema.test.ts` — same 11 test cases, same assertions, only the file's location and its own internal imports are unchanged since the test file imports from `./document.schema.js`, which still resolves correctly after the co-located move).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move document.schema.ts to src/domain/, update all importers"
```

---

## Task 3: `src/domain/taxonomy.ts`

**Files:**
- Create: `src/domain/taxonomy.ts`
- Modify: `src/services/triage.service.ts` (remove the 4 functions, import them back, fix the one `computeCanonicalPath` call site)
- Modify: `src/server/web_server.ts`, `src/mcp/server.ts` (import path for `isForbiddenSubcategory`)
- Create: `src/domain/taxonomy.test.ts`
- Delete: `src/services/triage.service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `isYearString(str?: string): boolean`, `isForbiddenSubcategory(subcategory?: string): boolean`, `isPathInsideDir(fullPath: string, dirPath: string): boolean` (newly exported — was private), `computeCanonicalPath(originalPath: string, category: string, outputRootDir: string, subcategory?: string, dateStr?: string): string` — **signature changed**: `outputRootDir` is now a required 3rd parameter (moved off `CONFIG.OUTPUT_ROOT_DIR`); `subcategory`/`dateStr` shift to 4th/5th position.

- [ ] **Step 1: Create `src/domain/taxonomy.ts`**

```ts
import path from 'path';

// True only if `fullPath` IS `dirPath`, or is actually nested inside it — a plain
// string-prefix check would also match an unrelated sibling that merely shares a
// prefix (e.g. "__archive" vs "__archive_old").
export function isPathInsideDir(fullPath: string, dirPath: string): boolean {
  const normFull = path.normalize(fullPath).toLowerCase();
  const normDir = path.normalize(dirPath).toLowerCase();
  return normFull === normDir || normFull.startsWith(normDir + path.sep);
}

export function isYearString(str?: string): boolean {
  return !!str && /^\d{4}$/.test(str.trim());
}

// Golden Rule #4: general/other/divers/empty/year-only are never valid final
// subcategories — any write path that lets a caller set an explicit subcategory
// must reject these, not just the initial classification flow.
const FORBIDDEN_SUBCATEGORIES = new Set(['general', 'other', 'divers']);
export function isForbiddenSubcategory(subcategory?: string): boolean {
  if (!subcategory) return true;
  const normalized = subcategory.toLowerCase().trim();
  if (normalized.length === 0) return true;
  return FORBIDDEN_SUBCATEGORIES.has(normalized) || isYearString(normalized);
}

export function computeCanonicalPath(
  originalPath: string,
  category: string,
  outputRootDir: string,
  subcategory?: string,
  dateStr?: string
): string {
  const file = path.basename(originalPath);
  const cleanCat = category ? category.toLowerCase().trim() : 'other';
  let cleanSub = subcategory ? subcategory.toLowerCase().trim() : 'general';

  if (isYearString(cleanSub)) {
    cleanSub = 'general';
  }

  let yearStr = new Date().getFullYear().toString();
  if (dateStr && dateStr.length >= 4) {
    const match = dateStr.match(/\b(20\d{2})\b/);
    if (match) {
      yearStr = match[1];
    }
  }

  const subParts = cleanSub.split(/[\/\\]+/).filter(Boolean);
  return path.join(outputRootDir, cleanCat, ...subParts, yearStr, file);
}
```

- [ ] **Step 2: Remove the 4 functions from `src/services/triage.service.ts`, import them back, fix the call site**

Delete from `src/services/triage.service.ts`: the `isPathInsideDir` function (currently lines 59-66), the `isYearString` function (lines 107-109), the `FORBIDDEN_SUBCATEGORIES` const + `isForbiddenSubcategory` function (lines 111-120), and the `computeCanonicalPath` function (lines 122-146).

Change the top import block from:
```ts
import fs from 'fs';
import path from 'path';
import { CONFIG, BASE_DIR, ensureDirectoriesExist, reloadConfigFromDisk } from '../config.js';
import { extractPDFContent } from './pdf.service.js';
import { classifyPDFText, generateEmbedding, ruleBasedClassify, getCategoriesConfig, saveCategoriesConfig } from './ai.service.js';
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getAllDocuments, getDb, getDocumentById } from '../db/database.js';
import { syncJSONRegistry } from './json_registry.service.js';
import { logger } from './logger.service.js';
```
to:
```ts
import fs from 'fs';
import path from 'path';
import { CONFIG, BASE_DIR, ensureDirectoriesExist, reloadConfigFromDisk } from '../config.js';
import { extractPDFContent } from './pdf.service.js';
import { classifyPDFText, generateEmbedding, ruleBasedClassify, getCategoriesConfig, saveCategoriesConfig } from './ai.service.js';
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getAllDocuments, getDb, getDocumentById } from '../db/database.js';
import { syncJSONRegistry } from './json_registry.service.js';
import { logger } from './logger.service.js';
import { isYearString, isForbiddenSubcategory, isPathInsideDir, computeCanonicalPath } from '../domain/taxonomy.js';
```

Fix the one call site inside `relocalizeFileIfNeeded` — change:
```ts
  const targetPath = computeCanonicalPath(filePath, category, subcategory, dateStr);
```
to:
```ts
  const targetPath = computeCanonicalPath(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr);
```

- [ ] **Step 3: Update `isForbiddenSubcategory`'s import in `src/server/web_server.ts`**

Change:
```ts
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, getPDFsRecursively, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws, ensureCategoryAndSubcategoryExist, isForbiddenSubcategory } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, getPDFsRecursively, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws, ensureCategoryAndSubcategoryExist } from '../services/triage.service.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
```

- [ ] **Step 4: Update `isForbiddenSubcategory`'s import in `src/mcp/server.ts`**

Change:
```ts
import { runTriageScan, relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist, isForbiddenSubcategory, ScanInProgressError } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan, relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist, ScanInProgressError } from '../services/triage.service.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
```

- [ ] **Step 5: Relocate and rewrite the test file**

```bash
git rm src/services/triage.service.test.ts
```

Create `src/domain/taxonomy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'path';
import { isYearString, isForbiddenSubcategory, computeCanonicalPath } from './taxonomy.js';

const TEST_OUTPUT_ROOT = 'C:\\test-archive';

describe('isYearString', () => {
  it('accepts a plain 4-digit year', () => {
    expect(isYearString('2023')).toBe(true);
  });

  it('accepts a 4-digit year with surrounding whitespace', () => {
    expect(isYearString('  2023  ')).toBe(true);
  });

  it('rejects a 5-digit number', () => {
    expect(isYearString('20233')).toBe(false);
  });

  it('rejects non-numeric text', () => {
    expect(isYearString('abcd')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isYearString(undefined)).toBe(false);
  });
});

describe('isForbiddenSubcategory', () => {
  it('forbids "general", "other", "divers" case-insensitively', () => {
    expect(isForbiddenSubcategory('general')).toBe(true);
    expect(isForbiddenSubcategory('GENERAL')).toBe(true);
    expect(isForbiddenSubcategory('other')).toBe(true);
    expect(isForbiddenSubcategory('divers')).toBe(true);
  });

  it('forbids a bare year string', () => {
    expect(isForbiddenSubcategory('2023')).toBe(true);
  });

  it('forbids undefined and empty string', () => {
    expect(isForbiddenSubcategory(undefined)).toBe(true);
    expect(isForbiddenSubcategory('')).toBe(true);
    expect(isForbiddenSubcategory('   ')).toBe(true);
  });

  it('allows a real, specific subcategory slug', () => {
    expect(isForbiddenSubcategory('sfr')).toBe(false);
    expect(isForbiddenSubcategory('credit_mutuel')).toBe(false);
  });
});

describe('computeCanonicalPath', () => {
  it('builds category/subcategory/year/filename under outputRootDir', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', TEST_OUTPUT_ROOT, 'sfr', '2024-05-12');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'sfr', '2024', 'facture.pdf'));
  });

  it('falls back to the current year when dateStr has no 20xx year', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', TEST_OUTPUT_ROOT, 'sfr', undefined);
    const currentYear = new Date().getFullYear().toString();
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'sfr', currentYear, 'facture.pdf'));
  });

  it('coerces a bare-year subcategory to "general" instead of nesting under a year folder', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'administrative', TEST_OUTPUT_ROOT, '2023', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'administrative', 'general', '2024', 'doc.pdf'));
  });

  it('defaults an empty category to "other" and empty subcategory to "general"', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', '', TEST_OUTPUT_ROOT, '', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'other', 'general', '2024', 'doc.pdf'));
  });

  it('splits a subcategory containing a slash into nested path segments', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'invoices', TEST_OUTPUT_ROOT, 'foo/bar', '2024-01-01');
    expect(result).toBe(path.join(TEST_OUTPUT_ROOT, 'invoices', 'foo', 'bar', '2024', 'doc.pdf'));
  });
});
```

Note this version no longer imports the real `CONFIG` at all — it uses a literal `TEST_OUTPUT_ROOT` constant, which is simpler than Phase 1's version and no longer depends on this machine's `settings.json`.

- [ ] **Step 6: Verify**

Run: `npm run build && npm test`

Expected: both clean, 69 tests passing (same 14 taxonomy assertions, now in `src/domain/taxonomy.test.ts`; the removed `import { CONFIG } from '../config.js';` line is gone from the test file, which is fine since `triage.service.ts` itself still imports `CONFIG` directly and is unaffected).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract taxonomy helpers to src/domain/taxonomy.ts, computeCanonicalPath takes outputRootDir as a parameter"
```

---

## Task 4: `src/domain/classification.ts`

The biggest single task in this plan — `ai.service.ts`'s classification/parsing logic moves out, with the entity dictionary and personal-name denylist becoming parameters instead of internal `fs`/`CONFIG` reads.

**Files:**
- Create: `src/domain/classification.ts`
- Modify: `src/services/ai.service.ts` (remove the moved functions, import them back, update `classifyPDFText`'s internal calls to pass the now-required parameters)
- Modify: `src/services/triage.service.ts` (its one `ruleBasedClassify` call site, inside `repairRegistry`, needs the two new arguments)
- Create: `src/domain/classification.test.ts` (replaces the corresponding blocks of `src/services/ai.service.test.ts`)

**Interfaces:**
- Consumes: `EntityDictionary`, `EntityItem` types from `src/domain/document.schema.js` (Task 2).
- Produces (all exported from `src/domain/classification.ts`):
  - `normalizeSlug(str: string): string` — **newly exported** (was private).
  - `cleanAndParseJSON(rawStr: string): any` — unchanged.
  - `isGroundedSubcategorySlug(slug: string, rawText: string, filename: string, personalNameDenylist: string[]): boolean` — **signature changed**, 4th param added.
  - `matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[], dictionary: EntityDictionary): { categorie: string; subcategorie: string } | null` — **signature changed**, 3rd param added.
  - `buildEntityHintLine(categoryId: string, dictionary: EntityDictionary): string` — **signature changed**, 2nd param added.
  - `ruleBasedClassify(rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): { categorie: string; subcategorie: string; title: string; date: string }` — **signature changed**, 3rd/4th params added.
  - `buildCategoriesDescriptionStr(categoriesConfig: { categories: CategoryItem[] }, dictionary: EntityDictionary): string` — **signature changed**, 2nd param added.
  - `ALL_ENTITY_DOMAINS: (keyof EntityDictionary)[]` — unchanged constant.

- [ ] **Step 1: Create `src/domain/classification.ts`**

```ts
import { CategoryItem, EntityDictionary } from './document.schema.js';

const DOMAIN_CATEGORY_MAP: Record<keyof EntityDictionary, string> = {
  banks: 'administrative',
  energy: 'invoices',
  telecom: 'invoices',
  insurance: 'insurance',
  gov: 'administrative',
  health: 'health'
};

export const ALL_ENTITY_DOMAINS = Object.keys(DOMAIN_CATEGORY_MAP) as (keyof EntityDictionary)[];

export function matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[], dictionary: EntityDictionary): { categorie: string; subcategorie: string } | null {
  for (const domain of domains) {
    const categorie = DOMAIN_CATEGORY_MAP[domain];
    for (const entry of dictionary[domain]) {
      const candidates = [entry.name, ...entry.aliases];
      for (const candidate of candidates) {
        const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped.length === 0) continue;
        // Use Unicode-aware word boundaries to correctly handle accented characters
        if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(combined)) {
          return { categorie, subcategorie: entry.slug };
        }
      }
    }
  }
  return null;
}

export function buildEntityHintLine(categoryId: string, dictionary: EntityDictionary): string {
  const domains = ALL_ENTITY_DOMAINS.filter(domain => DOMAIN_CATEGORY_MAP[domain] === categoryId);
  const entries = domains.flatMap(domain => dictionary[domain]);
  if (entries.length === 0) return '';
  return ` Known real-world entities: ${entries.map(e => `${e.slug} (${e.name})`).join(', ')}.`;
}

export function normalizeSlug(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// --- Ungrounded subcategory slug guard --------------------------------------------------
// When neither the curated regex list nor the entity dictionary recognizes a real entity,
// both the Qwen prompt (classifyPDFText) and ruleBasedClassify's last-resort fallback are
// tempted to invent a subcategory slug from the filename itself — e.g.
// "DcyJXe9MT9i7Un7tOlhU_StanW.pdf" -> "dcyjxe9mt9i7un7tolhu", "Page de confirmation.pdf"
// -> "page". That slug then gets permanently auto-created in categories.json (Golden Rule
// #5) even though it names nothing real. A "specific"-looking slug is only accepted here if
// it is actually grounded in the document's own text — not merely echoed from the filename
// or a generic/structural word.

const GENERIC_SLUG_DENYLIST = new Set([
  'general', 'other', 'divers', 'autre', 'autres', 'various', 'misc', 'note', 'notes',
  'info', 'page', 'bon', 'export', 'scan', 'copie', 'copy', 'document', 'doc', 'fichier',
  'file', 'image', 'confirmation', 'recu', 'releve', 'extrait', 'titre',
  'contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'
]);

const MIN_GROUNDED_SLUG_LENGTH = 3;

function filenameSlugTokens(filename: string): string[] {
  const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
  return cleanName.split('_').filter(w => w.length >= 3 && !/^\d+$/.test(w));
}

function isFilenameEchoedSlug(slug: string, filename: string): boolean {
  const wholeFilenameSlug = normalizeSlug(filename.replace(/\.pdf$/i, ''));
  if (slug === wholeFilenameSlug) return true;
  return filenameSlugTokens(filename).some(t => t === slug || slug.includes(t) || t.includes(slug));
}

function countSlugOccurrences(slug: string, text: string): number {
  // Slugs are snake_case but real document text uses spaces/hyphens between words (e.g.
  // slug "france_travail" must still match body text "France Travail"), so underscores
  // become a flexible separator instead of a literal character.
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[\\s_-]+');
  if (!escaped) return 0;
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  return (text.match(regex) || []).length;
}

/**
 * True only if `slug` looks like a real-world entity name grounded in the document's own
 * text, as opposed to a generic/structural word, gibberish, or an echo of the filename.
 * Used to gate the dynamic subcategory auto-create path in both classifyPDFText and
 * ruleBasedClassify. Exported for testing.
 */
export function isGroundedSubcategorySlug(slug: string, rawText: string, filename: string, personalNameDenylist: string[]): boolean {
  if (!slug || slug.length < MIN_GROUNDED_SLUG_LENGTH) return false;
  if (GENERIC_SLUG_DENYLIST.has(slug)) return false;
  const denylistSet = new Set(personalNameDenylist.map(n => n.toLowerCase().trim()));
  if (slug.split('_').some(part => denylistSet.has(part))) return false;

  const occurrences = countSlugOccurrences(slug, rawText || '');
  if (occurrences === 0) return false;

  if (isFilenameEchoedSlug(slug, filename)) {
    // A slug that's also present in the filename is exactly what a hallucinating model
    // falls back to — require it to show up more than once in the body (letterhead,
    // footer, reference line, ...) rather than a single incidental mention.
    return occurrences >= 2;
  }

  return true;
}

function repairTruncatedJSON(text: string): string {
  let result = text;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const ch of result) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }

  if (inString) {
    result += '"';
  }
  while (stack.length > 0) {
    const open = stack.pop();
    result += open === '{' ? '}' : ']';
  }
  return result;
}

export function cleanAndParseJSON(rawStr: string): any {
  let text = rawStr.trim();
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in AI response');
  }
  text = text.substring(start);

  const end = text.lastIndexOf('}');
  const candidate = end !== -1 ? text.substring(0, end + 1) : text;
  const cleaned = candidate.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Response was likely truncated mid-generation (e.g. context/length limit cut off
    // markdown_content before the closing brace). Repair by closing any unterminated
    // string and any brackets left open, respecting string boundaries, then retry.
    const repaired = repairTruncatedJSON(text).replace(/,\s*([\}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

export function ruleBasedClassify(rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): { categorie: string; subcategorie: string; title: string; date: string } {
  const combined = (filename + ' ' + rawText.substring(0, 4000)).toLowerCase();

  // Generic bank-statement signal phrases (same signals as the Qwen prompt's STEP 1)
  // used to guard the gov (7b) and insurance-dictionary (8) branches so a
  // Crédit Mutuel relevé isn't misfiled via a transaction-row mention of
  // CAF / AXA / etc. (Golden Rule #6 "archetypal trap").
  const looksLikeBankStatement = /\b(relev[ée] de compte|solde cr[ée]diteur|c\/c eurocompte)\b/i.test(combined);

  let categorie = 'administrative';
  let subcategorie = 'general';

  // Specific Bulletin de Salaire / Pay Slips Category (SEPARATE FROM INVOICES / FACTURES!)
  if (/bulletindesalaire|bulletin de salaire|bulletin de paie|fiche de paie/i.test(combined)) {
    categorie = 'bulletin_salaire';
    if (/globex|globex/i.test(combined)) subcategorie = 'globex';
    else if (/ecole_x/i.test(combined)) subcategorie = 'ecole_x';
    else if (/ecole_y/i.test(combined)) subcategorie = 'ecole_y';
    else if (/capgemini/i.test(combined)) subcategorie = 'capgemini';
    else if (/pacifique/i.test(combined) || /2017|2018/.test(filename)) subcategorie = 'employeur_x';
    else subcategorie = 'divers';
  }
  // Specific Internship Attestations
  else if (/attestationstageglobex|globex/i.test(combined)) {
    categorie = 'education';
    subcategorie = 'globex';
  }
  // Specific 2DDoc Contract Holder Domicile Proof Attestations
  else if (/attestationtitulairecontrat2ddoc|2ddoc/i.test(combined)) {
    categorie = 'housing';
    subcategorie = 'justificatif_domicile';
  }
  // 1. Identity & Passports & Civil Records
  else if (/(passeport|passport|carte d'identité|cni|cancuoccongdan|giaypheplaixe|giay phep lai xe|permis de conduire|titre de séjour|titresejour|carte vitale|cartevitale|acte de mariage|actemariage|acte de naissance|livret de famille)/i.test(combined)) {
    categorie = 'identity';
    if (/(passeport|passport)/i.test(combined)) subcategorie = 'passeport';
    else if (/(titre de séjour|titresejour)/i.test(combined)) subcategorie = 'titre_sejour';
    else if (/(carte vitale|cartevitale)/i.test(combined)) subcategorie = 'carte_vitale';
    else if (/(giaypheplaixe|giay phep lai xe|permis de conduire)/i.test(combined)) subcategorie = 'permis_conduire';
    else if (/(cancuoccongdan|carte d'identité|cni)/i.test(combined)) subcategorie = 'carte_identite';
    else if (/(actemariage|acte de mariage)/i.test(combined)) subcategorie = 'acte_mariage';
  }
  // 2. Health / Medical
  else if (/\b(santé|sante|médical|medical|soins|dentaire|pharmacie|attestation de droits|attestationam|ameli|sécurité sociale|securite sociale|cpam|mutuelle|hospitalisation)\b/i.test(combined)) {
    categorie = 'health';
    if (/\bameli|assurance maladie|cpam|attestationam\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\bgan\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bclinic_x|clinic_x\b/i.test(combined)) subcategorie = 'clinic_x';
    else {
      const dictHealth = matchEntityDictionary(combined, ['health'], dictionary);
      if (dictHealth) subcategorie = dictHealth.subcategorie;
    }
  }
  // 3. Housing & Domicile Proof
  else if (/\b(justificatif de domicile|attestation d'hébergement|attestation hebergement|attestation cercles|declarationhonneur|quittance de loyer|foncia|logement)\b/i.test(combined)) {
    categorie = 'housing';
    if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else subcategorie = 'justificatif_domicile';
  }
  // 4. Education & Academic Diplomas
  else if (/\b(formation|bachelor|étudiant|scolarité|inscription|ecole_y|ecole_x|ecole_z|openclassrooms|école|université|diplôme|diplome|bulletinscolaire|certificat|alternance|l1informatique)\b/i.test(combined)) {
    categorie = 'education';
    if (/\becole_x\b/i.test(combined)) subcategorie = 'ecole_x';
    else if (/\becole_y\b/i.test(combined)) subcategorie = 'ecole_y';
    else if (/\becole_z\b/i.test(combined)) subcategorie = 'ecole_z';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\bdiplome|diplôme|bulletinscolaire|certificat|l1informatique\b/i.test(combined)) subcategorie = 'diplomes';
  }
  // 5. Contracts & General Conditions
  else if (/\b(contrat de travail|cdi|cdd|avenant au contrat|cg de mon contrat|conditions générales|notice-attestation-employeur|attestation-employeur|engagement|convention collective)\b/i.test(combined)) {
    categorie = 'contracts';
    if (/\bcg|conditions générales\b/i.test(combined)) subcategorie = 'conditions_generales';
    else if (/\bemployeur\b/i.test(combined)) subcategorie = 'attestation_employeur';
    else subcategorie = 'cdi_cdd';
  }
  // 6. Vendor Invoices (EXCLUDING PAY SLIPS)
  else if (/\b(facture n°|facture no|facture|invoice|quittance|montant à payer|total ttc)\b/i.test(combined)) {
    categorie = 'invoices';
    if (/\bsfr\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else {
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy'], dictionary);
      if (dictVendor) {
        subcategorie = dictVendor.subcategorie;
      } else {
        const dictInsuranceViaFacture = matchEntityDictionary(combined, ['insurance'], dictionary);
        if (dictInsuranceViaFacture) {
          categorie = dictInsuranceViaFacture.categorie;
          subcategorie = dictInsuranceViaFacture.subcategorie;
        }
      }
    }
  }
  // 7. Taxes & Government Income Statements
  // Same bank-statement trap as 7b/8 below: a transaction row mentioning "prélèvements
  // sociaux" or "impôt" inside a relevé de compte must not divert this to 'impot'.
  else if (!looksLikeBankStatement && /\b(avis[ _-]d[ _-]impot|avis[ _-]d'impot|avis[ _-]impot|déclaration[ _-]d'impôt|taxe[ _-]fonciere|taxe[ _-]foncière|taxe[ _-]d'habitation|revenus[ _-]et[ _-]prelev|prélèvement[ _-]sociaux|prelev[ _-]sociaux|finances[ _-]publiques|dgfip|impôt|impots)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'impot';
  }
  // 7b. Government & Social Agencies
  // Bank statements are the archetypal trap (Golden Rule #6): a transaction row
  // like "VIR CAF ALLOCATIONS FAMILIALES" or "PRLV AXA FRANCE IARD" inside a
  // Crédit Mutuel relevé must not divert classification to the gov/insurance
  // branches below. Guard both dictionary-driven clauses with this check.
  else if (!looksLikeBankStatement && matchEntityDictionary(combined, ['gov'], dictionary)) {
    const dictGov = matchEntityDictionary(combined, ['gov'], dictionary)!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
  // 8. Insurance / Assurances
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined) || (!looksLikeBankStatement && matchEntityDictionary(combined, ['insurance'], dictionary))) {
    categorie = 'insurance';
    if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else {
      const dictInsurance = matchEntityDictionary(combined, ['insurance'], dictionary);
      if (dictInsurance) subcategorie = dictInsurance.subcategorie;
    }
  }
  // 9. Banks / Finance
  else if (/\b(caisse de credit mutuel|crédit mutuel|credit mutuel|ccm marseille|creditmutuel)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'credit_mutuel';
  } else if (/\b(société générale|societe generale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'societe_generale';
  } else if (/\b(bnp paribas|bnp)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'bnp_paribas';
  } else if (/\b(boursorama|boursobank)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'boursobank';
  } else if (/\b(lcl|crédit lyonnais|credit lyonnais)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'lcl';
  } else if (/\b(la banque postale|banque postale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'la_banque_postale';
  } else if (matchEntityDictionary(combined, ['banks'], dictionary)) {
    const dictBank = matchEntityDictionary(combined, ['banks'], dictionary)!;
    categorie = dictBank.categorie;
    subcategorie = dictBank.subcategorie;
  }
  // 10. Recruitment
  else if (/\b(lettre de motivation|candidature|recrutement|curriculum|cv|postuler|entretien|recommandation)\b/i.test(combined)) {
    categorie = 'recruitment';
  }
  // 11. Correspondence
  else if (/\b(yahoo mail|courrier|lettre|email|mail|recommandé|notification)\b/i.test(combined)) {
    categorie = 'correspondence';
  }
  // 12. Technical
  else if (/\b(manuel|guide|spécification|notice|documentation|technique|schema)\b/i.test(combined)) {
    categorie = 'technical';
  }
  // 13. Reports
  else if (/\b(rapport|compte-rendu|projet|livrable|synthèse)\b/i.test(combined)) {
    categorie = 'reports';
  }

  // Exact Subcategory Fallbacks & Dynamic Subcategory Generation from Filename Keywords
  if (subcategorie === 'general') {
    if (/\becole_x\b/i.test(combined)) subcategorie = 'ecole_x';
    else if (/\becole_y\b/i.test(combined)) subcategorie = 'ecole_y';
    else if (/\becole_z\b/i.test(combined)) subcategorie = 'ecole_z';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\bcarrefour\b/i.test(combined)) subcategorie = 'carrefour';
    else if (/\bkairos\b/i.test(combined)) subcategorie = 'kairos';
    else if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else if (/\b(gan|gan santé|gan assurances)\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bcapgemini\b/i.test(combined)) subcategorie = 'capgemini';
    else if (/\b(sfr|red by sfr)\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bbouygues\b/i.test(combined)) subcategorie = 'bouygues';
    else if (/\bfree\b/i.test(combined)) subcategorie = 'free';
    else if (/\b(ameli|assurance maladie|cpam)\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\b(navigo|ile-de-france mobilités|ratp)\b/i.test(combined)) subcategorie = 'navigo';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else if (/\bfnac\b/i.test(combined)) subcategorie = 'fnac';
    else if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else if (matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)) {
      const dictAny = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)!;
      categorie = dictAny.categorie;
      subcategorie = dictAny.subcategorie;
    }
    else {
      // Dynamic Subcategory Extraction from Filename Words — ONLY accepted if the
      // resulting slug is actually grounded in the document text (isGroundedSubcategorySlug
      // above). Previously this unconditionally promoted a filename fragment (or a fully
      // random filename) to a permanent subcategory; now an ungrounded candidate is left as
      // 'general' so the caller's strict fail guard (Golden Rule #4) can BLOCK it instead.
      const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
      const words = cleanName.split('_').filter(w => w.length > 2 && !/^\d+$/.test(w) && !['pdf', 'doc', 'document', 'copy', 'scan', 'the', 'and', 'for', 'mon', 'mes', 'une', 'des', 'sur', 'les', 'par'].includes(w));
      if (words.length > 0) {
        const candidate = words.find(w => !['contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'].includes(w)) || words[0];
        if (candidate && candidate.length >= 3) {
          const candidateSlug = normalizeSlug(candidate);
          if (isGroundedSubcategorySlug(candidateSlug, rawText, filename, personalNameDenylist)) {
            subcategorie = candidateSlug;
          }
        }
      }
    }
  }

  let date = new Date().toISOString().split('T')[0];
  const compactDateMatch = combined.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  const dateMatch = combined.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/) ||
                    combined.match(/\b(0[1-9]|[12]\d|3[01])[-/](0[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (compactDateMatch) {
    date = `${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`;
  } else if (dateMatch) {
    if (dateMatch[1].length === 4) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } else {
      date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  const title = filename.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();

  return { categorie, subcategorie, title, date };
}

export function buildCategoriesDescriptionStr(categoriesConfig: { categories: CategoryItem[] }, dictionary: EntityDictionary): string {
  return categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    const entityHint = buildEntityHintLine(c.id, dictionary);
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}].${entityHint}`;
  }).join('\n');
}
```

- [ ] **Step 2: Trim `src/services/ai.service.ts` and wire in the new imports**

Delete from `src/services/ai.service.ts`: the `DOMAIN_CATEGORY_MAP` const, `ALL_ENTITY_DOMAINS` export, `matchEntityDictionary`, `buildEntityHintLine` functions (originally lines 49-97); the `normalizeSlug` function, the `GENERIC_SLUG_DENYLIST`/`MIN_GROUNDED_SLUG_LENGTH` consts, `filenameSlugTokens`, `isFilenameEchoedSlug`, `countSlugOccurrences`, `getPersonalNameDenylist`, `isGroundedSubcategorySlug` (originally lines 163-245); `repairTruncatedJSON`, `cleanAndParseJSON` (originally lines 247-305); `ruleBasedClassify` (originally lines 307-534); `buildCategoriesDescriptionStr` (originally lines 536-542).

Change the top import block from:
```ts
import { Ollama } from 'ollama';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';
import { logger } from './logger.service.js';
```
to:
```ts
import { Ollama } from 'ollama';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';
import { logger } from './logger.service.js';
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';
```

(`matchEntityDictionary`/`buildEntityHintLine`/`ALL_ENTITY_DOMAINS` aren't imported here — nothing left in `ai.service.ts` after this task calls them directly; `buildCategoriesDescriptionStr` calls `buildEntityHintLine` internally now.)

Inside `classifyPDFText`, three call sites need updating to pass the now-required parameters. First, where it builds the categories description string, change:
```ts
  const categoriesConfig = getCategoriesConfig();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig);
```
to:
```ts
  const categoriesConfig = getCategoriesConfig();
  const dictionary = getEntityDictionary();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig, dictionary);
```

Second, in the `catch` block's rule-based fallback, change:
```ts
  } catch (err: any) {
    logger.warn('OLLAMA_AI', `Ollama AI request failed for ${filename}: ${err.message}. Using rule-based classifier.`);
    const rb = ruleBasedClassify(rawText, filename);
```
to:
```ts
  } catch (err: any) {
    logger.warn('OLLAMA_AI', `Ollama AI request failed for ${filename}: ${err.message}. Using rule-based classifier.`);
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
```

Third, in the refinement block right after, change:
```ts
  if (validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename))) {
    const rb = ruleBasedClassify(rawText, filename);
```
to:
```ts
  if (validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename))) {
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
```

Fourth, the `isGroundedSubcategorySlug` call near the end of `classifyPDFText`, change:
```ts
  } else if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename)) {
```
to:
```ts
  } else if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST)) {
```

`getEntityDictionary()` is still defined locally in `ai.service.ts` at this point in the plan (it moves out in Task 12) — this task just adds one more call to it, reusing the same function that already exists in the file.

- [ ] **Step 3: Fix `ruleBasedClassify`'s call site in `src/services/triage.service.ts`**

Inside `repairRegistry`, change:
```ts
          const rb = ruleBasedClassify(raw_text || currentText, file);
```
to:
```ts
          const rb = ruleBasedClassify(raw_text || currentText, file, getEntityDictionary(), CONFIG.PERSONAL_NAME_DENYLIST);
```

`ruleBasedClassify` no longer lives in `ai.service.ts` after Step 2 of this task — it's now a local import there, not a re-export. Change the `ai.service.js` import line in `triage.service.ts`:
```ts
import { classifyPDFText, generateEmbedding, ruleBasedClassify, getCategoriesConfig, saveCategoriesConfig } from './ai.service.js';
```
to:
```ts
import { classifyPDFText, generateEmbedding, getCategoriesConfig, saveCategoriesConfig, getEntityDictionary } from './ai.service.js';
import { ruleBasedClassify } from '../domain/classification.js';
```

(`getEntityDictionary` is still exported from `ai.service.ts` itself at this point — it moves to infrastructure in Task 12, at which point this import updates again. `ruleBasedClassify` points straight at its new domain home since it's not coming back to `ai.service.ts`.)

- [ ] **Step 4: Relocate and rewrite the affected test blocks**

In `src/services/ai.service.test.ts`, this task moves the `cleanAndParseJSON`, `matchEntityDictionary`, `buildEntityHintLine`, `isGroundedSubcategorySlug`, and `ruleBasedClassify` describe blocks out — the file keeps only the `classifyPDFText` describe block (moves fully in Task 17) plus whatever mock scaffolding that block still needs.

Create `src/domain/classification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify } from './classification.js';
import { EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['dupond', 'martin', 'lefebvre', 'bernard'];

function dictionaryWith(overrides: Partial<EntityDictionary>): EntityDictionary {
  return { ...EMPTY_DICTIONARY, ...overrides };
}

describe('cleanAndParseJSON', () => {
  it('strips ```json fences and trailing commas', () => {
    const raw = '```json\n{"titre": "Test", "categorie": "invoices",}\n```';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', categorie: 'invoices' });
  });

  it('throws when the response has no JSON object at all', () => {
    expect(() => cleanAndParseJSON('I cannot help with that request.')).toThrow(
      'No JSON object found in AI response'
    );
  });

  it('repairs a truncated response (unterminated string, missing closing brace)', () => {
    const raw = '{"titre": "Test Doc", "markdown_content": "some unterminated text';
    expect(cleanAndParseJSON(raw)).toEqual({
      titre: 'Test Doc',
      markdown_content: 'some unterminated text',
    });
  });

  it('repairs truncation inside a nested array', () => {
    const raw = '{"titre": "Test", "tags": ["a", "b"';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', tags: ['a', 'b'] });
  });

  it('ignores text before the first { and after the last }', () => {
    const raw = 'Here is the JSON: {"titre": "Test"} — hope that helps!';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test' });
  });
});

describe('matchEntityDictionary', () => {
  it('matches an entity by its exact name, case-insensitively', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: ['ca'] }] });
    const result = matchEntityDictionary('extrait de compte crédit agricole paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'credit_agricole' });
  });

  it('matches an entity by alias', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'maif', name: 'MAIF', aliases: ['mutuelle assurance instituteurs'] }] });
    const result = matchEntityDictionary('contrat mutuelle assurance instituteurs 2024', ['insurance'], dict);
    expect(result).toEqual({ categorie: 'insurance', subcategorie: 'maif' });
  });

  it('matches accented entity names against accented text (Unicode word boundary)', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'societe_generale', name: 'Société Générale', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte société générale paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'societe_generale' });
  });

  it('does NOT match an accented entity name against unaccented search text — this is why every accented entity in entity_dictionary.json must also ship an unaccented alias', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte credit agricole paris', ['banks'], dict);
    expect(result).toBeNull();
  });

  it('does not match a name as a substring of a longer word (word-boundary correctness)', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }] });
    // "taxaphone" contains "axa" as a substring but is not a match
    const result = matchEntityDictionary('société taxaphone service client', ['insurance'], dict);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(matchEntityDictionary('nothing recognizable here', ['banks'], dict)).toBeNull();
  });
});

describe('buildEntityHintLine', () => {
  it('formats matching entities as "slug (Name), slug (Name)."', () => {
    const dict = dictionaryWith({
      banks: [
        { slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] },
        { slug: 'fortuneo', name: 'Fortuneo', aliases: [] },
      ],
    });
    expect(buildEntityHintLine('administrative', dict)).toBe(
      ' Known real-world entities: credit_agricole (Crédit Agricole), fortuneo (Fortuneo).'
    );
  });

  it('returns an empty string when no domain maps to the category', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(buildEntityHintLine('totally_made_up_category_xyz', dict)).toBe('');
  });
});

describe('isGroundedSubcategorySlug', () => {
  it('rejects a slug shorter than 3 characters', () => {
    expect(isGroundedSubcategorySlug('ab', 'ab ab ab', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a generic/structural word even if it appears in the text', () => {
    expect(isGroundedSubcategorySlug('page', 'page 1 of page 2', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug built from a personal/household name token', () => {
    expect(isGroundedSubcategorySlug('jean_dupond', 'jean dupond jean dupond', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug with zero occurrences in the document text', () => {
    expect(isGroundedSubcategorySlug('veolia', 'nothing here', 'random.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a filename-echoed slug that appears only once in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia mentioned once', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(false);
  });

  it('accepts a filename-echoed slug that appears at least twice in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });

  it('accepts a non-filename-echoed slug that appears once in the text', () => {
    expect(
      isGroundedSubcategorySlug('france_travail', 'Contact France Travail for details', 'doc123.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });
});

describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const result = ruleBasedClassify(
      'Bulletin de salaire EmployeurX Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result).toEqual({
      categorie: 'bulletin_salaire',
      subcategorie: 'employeur_x',
      title: 'bulletin mars',
      date: '2023-03-01',
    });
  });

  it('classifies a passport under identity/passeport', () => {
    const result = ruleBasedClassify('Republique Francaise Passeport N 12AB34567', 'doc.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('identity');
    expect(result.subcategorie).toBe('passeport');
  });

  it('classifies a plain tax notice under administrative/impot', () => {
    const result = ruleBasedClassify(
      "Direction Generale des Finances Publiques DGFIP Avis d'impot sur le revenu 2023",
      'impot2023.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('impot');
  });

  it('does NOT misfile a bank statement as impot just because a transaction row mentions impots (Golden Rule #6 guard)', () => {
    const result = ruleBasedClassify(
      'RELEVE DE COMPTE Credit Mutuel Marseille PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
      'releve.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('classifies a vendor invoice via the hardcoded regex branch, with compact YYYYMMDD date', () => {
    const result = ruleBasedClassify('Facture SFR n 123456 Total TTC 45.99 EUR 20240512', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result).toEqual({
      categorie: 'invoices',
      subcategorie: 'sfr',
      title: 'facture',
      date: '2024-05-12',
    });
  });

  it('classifies a vendor invoice via the entity-dictionary fallback when no hardcoded regex matches', () => {
    const dict = dictionaryWith({ energy: [{ slug: 'ekwateur', name: 'Ekwateur', aliases: [] }] });
    const result = ruleBasedClassify('Facture Ekwateur Total TTC 45 EUR', 'facture2.pdf', dict, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('ekwateur');
  });

  it('leaves subcategorie as "general" when no signal matches and the filename word is not grounded in the text', () => {
    const result = ruleBasedClassify(
      'Hello world this is a test document with nothing recognizable.',
      'randomfile.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('general');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to today's date — don't assert the exact day
  });

  it('dynamically accepts a new subcategory slug from the filename when it is genuinely grounded in the text', () => {
    const result = ruleBasedClassify(
      'Contrat Veolia Eau - consommation trimestrielle, montant total 32.10 EUR. Merci de votre confiance, Veolia.',
      'veolia_invoice.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('veolia');
  });
});
```

Note this version drops `vi.mock('fs')` and the `mockEntityDictionary` fs-mocking helper entirely — every test builds a plain `EntityDictionary` object literal and passes it directly, exactly the payoff described in the design spec's Section 5.

In `src/services/ai.service.test.ts`, remove the 5 describe blocks above (`cleanAndParseJSON`, `matchEntityDictionary`, `buildEntityHintLine`, `isGroundedSubcategorySlug`, `ruleBasedClassify`) and their now-unused imports (`fs`, `vi.mock('fs')`, `mockEntityDictionary` helper) — but do NOT touch the `vi.mock('ollama', ...)` hoisted mock block or the `classifyPDFText` describe block; those stay for now (Task 17 relocates them). The remaining top-of-file block becomes:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';

const { generateMock, listMock, pullMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
  pullMock: vi.fn(),
}));

vi.mock('ollama', () => ({
  // NOTE: must be a regular `function`, not an arrow function — ai.service.ts calls
  // `new Ollama(...)`, and arrow functions can never be used as constructors in JS.
  // An arrow-function implementation throws "is not a constructor" under `new`.
  Ollama: vi.fn().mockImplementation(function () {
    return {
      generate: generateMock,
      list: listMock,
      pull: pullMock,
    };
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
});
```

Everything below that (the `describe('classifyPDFText', ...)` block) stays exactly as it is today — but note this intermediate state still references `vi.mocked(fs.existsSync)` inside its own `beforeEach`, so it needs its own local `import fs from 'fs';` and `vi.mock('fs');` added back since the file-level ones were just removed. Add these two lines right after the `vitest`/`ollama` imports shown above:

```ts
import fs from 'fs';

vi.mock('fs');
```

(placed before the `vi.hoisted(...)` call, matching the original file's line order — `import fs from 'fs';` goes with the other imports at the very top, `vi.mock('fs');` goes with the other `vi.mock(...)` calls.)

- [ ] **Step 5: Verify**

Run: `npm run build && npm test`

Expected: both clean. Test count: `src/domain/classification.test.ts` has 27 tests (5 + 6 + 2 + 7 + 7 — note `matchEntityDictionary` gained the accent-negative test in Phase 1's fix wave, so 6 not 5), `src/services/ai.service.test.ts` keeps its 3 `classifyPDFText` tests. Total across the whole suite stays 69 (nothing added or dropped, only relocated — Phase 1 ended at 69 after its fix wave, matching this task's 27 + 3 + everything else unchanged).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract classification logic to src/domain/classification.ts, dictionary/denylist now parameters"
```

---

## Task 5: `src/domain/prompt.ts` (new extraction)

**Files:**
- Create: `src/domain/prompt.ts`
- Modify: `src/services/ai.service.ts` (`classifyPDFText` calls the new function instead of building the prompt inline)
- Create: `src/domain/prompt.test.ts`

**Interfaces:**
- Produces: `buildClassificationPrompt(categoriesDescriptionStr: string, filename: string, rawText: string, previousError?: string): { system: string; user: string }`.

- [ ] **Step 1: Create `src/domain/prompt.ts`**

```ts
export function buildClassificationPrompt(
  categoriesDescriptionStr: string,
  filename: string,
  rawText: string,
  previousError?: string
): { system: string; user: string } {
  const textSnippet = rawText.length > 4000 ? rawText.substring(0, 4000) + '...' : rawText;

  const system = `You are an expert AI document archivist and classifier. 
Your task is to analyze document text, select the best Category, and select or create the best Subcategory following this strict Step-by-Step Decision Flow.

Available Categories & Existing Subcategories:
${categoriesDescriptionStr}

🛑 MANDATORY DEEP CONTENT READING RULE (READ FULL CONTENT & PURPOSE, DO NOT JUST MATCH WORDS!):
- You MUST READ AND UNDERSTAND THE ENTIRE CONTEXT, PURPOSE, AND ISSUING ENTITY of the document content.
- DO NOT rely on simple string keyword matching or isolated word occurrences!
- PAY SLIPS (bulletin de salaire) MUST BE CLASSIFIED UNDER Category = 'bulletin_salaire' (NOT 'invoices'!).
- For PAY SLIPS, identify the Employer/Enterprise Name (e.g. 'employeur_x', 'globex', 'capgemini', 'ecole_x'). Set Subcategory = Exact Employer Name!

🧠 LOCAL AI THINKING & REASONING PROTOCOL (THINK STEP-BY-STEP BEFORE OUTPUT):
1. HEADER VS BODY AUDIT: First, inspect the header/issuer of the document. Distinguish the issuing entity from transaction line items.
2. FULL CONTENT PURPOSE ANALYSIS: Read the body text to understand the legal, financial, or administrative purpose of the document.
3. CATEGORY SELECTION: Evaluate the 12-step decision flow in strict order. Pick the single most accurate category.
4. SPECIFIC SUBCATEGORY SELECTION:
   - Identify the exact company, bank, school, government branch, or document type (e.g. 'credit_mutuel', 'impot', 'globex', 'ameli', 'foncia', 'allianz', 'ecole_y', 'employeur_x').
   - If the issuing company or organization is NOT in existing subcategories, DYNAMICALLY GENERATE A NEW CLEAN SLUG for that exact entity — ONLY if that entity's name actually appears in the Document Text Content above (e.g. 'france_travail', 'caf', 'urssaf', 'veolia', 'orange'). NEVER derive the slug from the filename and NEVER guess — the filename is not document content.
   - If the document text itself has no identifiable real entity (illegible/weak OCR, a generic confirmation page, a form with no issuer name), output subcategorie as 'general' — that is the correct, honest answer here. Do NOT invent a fake-specific slug just to avoid saying 'general'.
   - Otherwise, when a real entity IS identifiable in the text, NEVER output 'general', 'personal', 'other', 'divers', or year strings ('2023') as subcategories!

🛑 MASTER AI CLASSIFICATION DECISION FLOW (FOLLOW IN STRICT ORDER):

STEP 1: BANK STATEMENTS (High Priority Override)
- Search document header for "Crédit Mutuel", "Société Générale", "BNP Paribas", "BoursoBank", "LCL", "La Banque Postale", "C/C EUROCOMPTE", "RELEVE DE COMPTE", "SOLDE CREDITEUR", or IBAN numbers.
- IF MATCH: -> Category = 'administrative', Subcategory = Exact Bank Name (e.g. 'credit_mutuel', 'societe_generale', 'bnp_paribas').
- ⚠️ CRITICAL RULE: Ignore vendor names (like SFR, PayPal, Amazon, Lidl) that appear inside internal transaction list rows!

STEP 2: TAX DOCUMENTS (High Priority Override)
- Search document for "Avis d'impôt", "Avis d'imposition", "Prélèvements sociaux", "Revenus 2022", "Finances Publiques", "DGFIP", "Taxe foncière", "Taxe d'habitation".
- IF MATCH: -> Category = 'administrative', Subcategory = 'impot'.
- ⚠️ CRITICAL RULE: NEVER classify tax forms as 'correspondence' or 'courriers'!

STEP 3: PAY SLIPS (HIGH PRIORITY CATEGORY)
- Search document for "Bulletin de salaire", "Bulletin de paie", "Fiche de paie", "Salaire brut", "Net à payer".
- IF MATCH: -> Category = 'bulletin_salaire', Subcategory = Exact Employer/Enterprise Name (e.g. 'employeur_x', 'globex', 'capgemini', 'ecole_x').
- ⚠️ CRITICAL RULE: NEVER put pay slips under 'invoices' (Factures)!

STEP 4: HEALTH & MEDICAL
- Search for "Ameli", "Assurance Maladie", "CPAM", "Mutuelle", "Gan Santé", "Ordonnance", "Soins Dentaires", "Pharmacie", "Hospitalisation".
- IF MATCH: -> Category = 'health', Subcategory = Health Institution (e.g. 'ameli', 'gan_sante', 'clinic_x').

STEP 5: IDENTITY & CIVIL PAPERS
- Search for "Passeport", "Passport", "Carte d'Identité", "CNI", "Titre de Séjour", "Carte Vitale", "Permis de conduire", "Acte de mariage", "Acte de naissance".
- IF MATCH: -> Category = 'identity', Subcategory = Document Type (e.g. 'passeport', 'titre_sejour', 'carte_vitale', 'permis_conduire', 'carte_identite', 'acte_mariage').

STEP 6: HOUSING & DOMICILE PROOF
- Search for "Justificatif de domicile", "Attestation d'hébergement", "Quittance de loyer", "Foncia", "Logement", "Bail d'habitation", "Attestation titulaire de contrat 2DDoc".
- IF MATCH: -> Category = 'housing', Subcategory = 'justificatif_domicile' or 'foncia'.

STEP 7: GENERAL INSURANCE
- Search for "Assurance Auto", "Assurance Habitation", "Prévoyance", "Responsabilité Civile", "Allianz", "Macif", "Maaf".
- IF MATCH: -> Category = 'insurance', Subcategory = Company Name (e.g. 'allianz').

STEP 8: VENDOR INVOICES (FACTURES)
- Search for "Facture n°", "Facture no", "Invoice", "Montant à payer", "Total TTC", "SFR", "EDF", "Engie", "Free", "Orange", "Cdiscount", "Amazon".
- IF MATCH: -> Category = 'invoices', Subcategory = Vendor Name (e.g. 'sfr', 'edf', 'cdiscount').

STEP 9: CONTRACTS & GENERAL CONDITIONS
- Search for "Contrat de travail", "CDI", "CDD", "Avenant au contrat", "Conditions générales", "Notice employeur", "Convention collective".
- IF MATCH: -> Category = 'contracts', Subcategory = Work, Conditions, or Company Name (e.g. 'cdi_cdd', 'conditions_generales', 'attestation_employeur').

STEP 10: EDUCATION & ACADEMIC
- Search for "Attestation de stage GLOBEX", "Certificat de scolarité", "Diplôme", "Bachelor", "Attestation de formation", "ECOLE_X", "ECOLE_Y", "EcoleZ", "OpenClassrooms".
- IF MATCH: -> Category = 'education', Subcategory = School or Company Name (e.g. 'globex', 'ecole_x', 'ecole_y', 'openclassrooms', 'diplomes').

STEP 11: RECRUITMENT
- Search for "Lettre de motivation", "CV", "Curriculum Vitae", "Candidature", "Postuler".
- IF MATCH: -> Category = 'recruitment', Subcategory = 'lettres_motivation'.

STEP 12: POSTAL MAIL & EMAILS
- Plain postal letters or emails without invoice, tax, or contract context -> Category = 'correspondence'.

STEP 13: TECHNICAL MANUALS & REPORTS
- Technical guides -> Category = 'technical'. Project reports -> Category = 'reports'.

Respond ONLY with raw JSON matching this structure:
{
  "titre": "Document Title",
  "registre": "REF-12345",
  "date": "2026-05-15",
  "categorie": "bulletin_salaire",
  "subcategorie": "employeur_x",
  "summary": "Executive summary...",
  "tags": ["bulletin_salaire", "employeur_x", "salaire"],
  "markdown_content": "# Document Title\\n\\nContent formatted in clean Markdown..."
}`;

  let user = `Filename: ${filename}\n\nDocument Text Content:\n${textSnippet}`;
  if (previousError) {
    user += `\n\n⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):\nThe previous classification attempt for this document encountered an error: "${previousError}".\nPlease carefully analyze the document text and fix this issue. You MUST provide a specific, valid Category and Subcategory slug that is genuinely grounded in the Document Text Content (e.g. 'credit_mutuel', 'impot', 'ameli', 'sfr') — do NOT derive it from the filename. If no real entity is identifiable in the text, it is correct to return 'general' rather than guessing.`;
  }

  return { system, user };
}
```

- [ ] **Step 2: Update `classifyPDFText` in `src/services/ai.service.ts` to use it**

Change:
```ts
  const textSnippet = rawText.length > 4000 ? rawText.substring(0, 4000) + '...' : rawText;

  const systemPrompt = `You are an expert AI document archivist and classifier. 
```
... (the entire inline template literal through its closing `` `; `` and the `let userPrompt = ...` / `if (previousError) { userPrompt += ...` block) ...

to:

```ts
  const { system: systemPrompt, user: userPromptBuilt } = buildClassificationPrompt(categoriesDescriptionStr, filename, rawText, previousError);
  let userPrompt = userPromptBuilt;
```

Add the import — change:
```ts
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';
```
to:
```ts
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';
import { buildClassificationPrompt } from '../domain/prompt.js';
```

The line right after (`logger.debug('OLLAMA_AI', ...)`) references `textSnippet.length`, which no longer exists in this scope now that `textSnippet` is computed inside `buildClassificationPrompt`. Change:
```ts
  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, textSnippetLength: textSnippet.length });
```
to:
```ts
  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, rawTextLength: rawText.length });
```
(This changes the logged field name and value — from the truncated prompt-snippet length to the full raw-text length — a debug-log-only cosmetic difference, not a behavior change to any classification decision or file placement. Note it in your task report.)

Everything else below that in `classifyPDFText` (the `try`/`catch` around `ollama.generate`, etc.) references `systemPrompt` and `userPrompt` exactly as before — no other changes needed in this task, since those two variable names are preserved.

- [ ] **Step 3: Create `src/domain/prompt.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt } from './prompt.js';

describe('buildClassificationPrompt', () => {
  it('embeds the categories description string into the system prompt', () => {
    const { system } = buildClassificationPrompt('- Category invoices: bills', 'facture.pdf', 'some text');
    expect(system).toContain('- Category invoices: bills');
  });

  it('truncates document text over 4000 chars in the user prompt, with an ellipsis', () => {
    const longText = 'a'.repeat(5000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', longText);
    expect(user).toContain('a'.repeat(4000) + '...');
    expect(user).not.toContain('a'.repeat(4001));
  });

  it('does not truncate document text at or under 4000 chars', () => {
    const shortText = 'b'.repeat(4000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', shortText);
    expect(user).toContain(shortText);
    expect(user).not.toContain('...');
  });

  it('includes the filename in the user prompt', () => {
    const { user } = buildClassificationPrompt('categories', 'my_invoice.pdf', 'text');
    expect(user).toContain('Filename: my_invoice.pdf');
  });

  it('appends the previous-error feedback block only when previousError is provided', () => {
    const withoutError = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(withoutError.user).not.toContain('PREVIOUS ATTEMPT FEEDBACK');

    const withError = buildClassificationPrompt('categories', 'doc.pdf', 'text', 'subcategory was ungrounded');
    expect(withError.user).toContain('PREVIOUS ATTEMPT FEEDBACK');
    expect(withError.user).toContain('subcategory was ungrounded');
  });
});
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, 74 tests (69 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract classification prompt building to src/domain/prompt.ts"
```

---

## Task 6: `src/domain/classification-resolution.ts` (new extraction)

**Files:**
- Create: `src/domain/classification-resolution.ts`
- Modify: `src/services/ai.service.ts` (`classifyPDFText` calls the new functions instead of the inline refinement/resolution blocks)
- Create: `src/domain/classification-resolution.test.ts`

**Interfaces:**
- Consumes: `ruleBasedClassify`, `isGroundedSubcategorySlug`, `normalizeSlug` from `src/domain/classification.js` (Task 4); `DocumentMetadata`, `CategoryItem`, `SubcategoryItem`, `EntityDictionary` from `src/domain/document.schema.js` (Task 2).
- Produces:
  - `refineClassification(validated: DocumentMetadata, rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): DocumentMetadata`
  - `resolveCategory(categoriesConfig: { categories: CategoryItem[] }, rawCategorie: string): { category: CategoryItem; isNew: boolean }` — mutates `categoriesConfig.categories` in place when creating a new entry (documented behavior, still zero I/O).
  - `resolveSubcategory(matchedCategory: CategoryItem, rawSubcategorie: string, rawText: string, filename: string, personalNameDenylist: string[]): { subcategoryId: string; isNew: boolean; newSubcategory?: SubcategoryItem }` — mutates `matchedCategory.subcategories` in place when creating a new entry.

- [ ] **Step 1: Create `src/domain/classification-resolution.ts`**

```ts
import { CategoryItem, SubcategoryItem, DocumentMetadata, EntityDictionary } from './document.schema.js';
import { ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug } from './classification.js';

// Refine Category & Subcategory using ruleBasedClassify if AI returned 'general', 'personal', 'other', or 'correspondence' for a Tax/Bank document
export function refineClassification(
  validated: DocumentMetadata,
  rawText: string,
  filename: string,
  dictionary: EntityDictionary,
  personalNameDenylist: string[]
): DocumentMetadata {
  if (!(validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename)))) {
    return validated;
  }

  const rb = ruleBasedClassify(rawText, filename, dictionary, personalNameDenylist);
  const result = { ...validated };

  if (validated.categorie === 'personal' || validated.categorie === 'other' || !validated.categorie || (validated.categorie === 'correspondence' && rb.categorie === 'administrative')) {
    result.categorie = rb.categorie;
  }
  if (validated.subcategorie === 'general' && rb.subcategorie !== 'general') {
    result.subcategorie = rb.subcategorie;
  }

  return result;
}

// Normalize category ID & resolve to an existing entry, or describe a new one to be
// auto-created BEFORE the file is moved (Golden Rule #5).
export function resolveCategory(categoriesConfig: { categories: CategoryItem[] }, rawCategorie: string): { category: CategoryItem; isNew: boolean } {
  const rawCatSlug = normalizeSlug(rawCategorie || 'administrative');
  const matchedCategory = categoriesConfig.categories.find(c =>
    c.id === rawCatSlug || (c.aliases && c.aliases.some(a => rawCatSlug.includes(a)))
  );

  if (matchedCategory) {
    return { category: matchedCategory, isNew: false };
  }

  const newCatSlug = rawCatSlug;
  const newCatName = newCatSlug
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const newCatObj: CategoryItem = {
    id: newCatSlug,
    name: newCatName,
    description: `Category auto-created for ${newCatName}`,
    aliases: [newCatSlug],
    subcategories: []
  };

  categoriesConfig.categories.push(newCatObj);
  return { category: newCatObj, isNew: true };
}

const FORBIDDEN_SUBCATEGORIES = new Set(['general', 'other', 'divers']);

// Normalize subcategory ID & resolve to an existing entry under `matchedCategory`, or
// describe a new one to be auto-created BEFORE the file is moved (Golden Rule #5) — unless
// the slug is forbidden (Golden Rule #4) or ungrounded (see isGroundedSubcategorySlug),
// in which case it resolves to 'general' so the caller's strict fail guard can BLOCK it.
export function resolveSubcategory(
  matchedCategory: CategoryItem,
  rawSubcategorie: string,
  rawText: string,
  filename: string,
  personalNameDenylist: string[]
): { subcategoryId: string; isNew: boolean; newSubcategory?: SubcategoryItem } {
  let rawSubSlug = normalizeSlug(rawSubcategorie || '');
  // Clean dates from subcategory slugs
  rawSubSlug = rawSubSlug.replace(/_\d{4,8}$/g, '').replace(/\d{4,8}$/g, '');

  if (!rawSubSlug || /^\d{4}$/.test(rawSubSlug)) {
    rawSubSlug = 'general';
  }

  if (!matchedCategory.subcategories) {
    matchedCategory.subcategories = [];
  }

  const matchedSub = FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)
    ? undefined
    : matchedCategory.subcategories.find(s =>
        s.id === rawSubSlug || (s.aliases && s.aliases.some(a => rawSubSlug.includes(a)))
      );

  if (matchedSub) {
    return { subcategoryId: matchedSub.id, isNew: false };
  }

  if (FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)) {
    // Forbidden sentinel value — never auto-create it as a real taxonomy entry. Return it
    // as-is so the caller's strict fail guard (Golden Rule #4) BLOCKs the file and keeps
    // it in __raws.
    return { subcategoryId: rawSubSlug, isNew: false };
  }

  if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename, personalNameDenylist)) {
    // The model (or the ruleBasedClassify refinement pass) invented a "specific"-looking
    // slug that isn't actually grounded in the document's own content — a filename echo,
    // gibberish, or a generic/structural word. Refuse to pollute categories.json with it;
    // resolve to 'general' so the caller's BLOCK guard catches it instead of silently
    // mis-filing the document under a garbage subcategory.
    return { subcategoryId: 'general', isNew: false };
  }

  const newSubName = rawSubSlug
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const newSubObj: SubcategoryItem = {
    id: rawSubSlug,
    name: newSubName,
    aliases: [rawSubSlug]
  };

  matchedCategory.subcategories.push(newSubObj);
  return { subcategoryId: rawSubSlug, isNew: true, newSubcategory: newSubObj };
}
```

- [ ] **Step 2: Update `classifyPDFText` in `src/services/ai.service.ts` to use the extracted functions**

Add the import — change:
```ts
import { buildClassificationPrompt } from '../domain/prompt.js';
```
to:
```ts
import { buildClassificationPrompt } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory } from '../domain/classification-resolution.js';
```

Replace the refinement block:
```ts
  // Refine Category & Subcategory using ruleBasedClassify if AI returned 'general', 'personal', 'other', or 'correspondence' for a Tax/Bank document
  if (validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename))) {
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    if (validated.categorie === 'personal' || validated.categorie === 'other' || !validated.categorie || (validated.categorie === 'correspondence' && rb.categorie === 'administrative')) {
      validated.categorie = rb.categorie;
    }
    if (validated.subcategorie === 'general' && rb.subcategorie !== 'general') {
      validated.subcategorie = rb.subcategorie;
    }
  }
```
with:
```ts
  validated = refineClassification(validated, rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
```

(Note: `validated` is declared with `let validated: DocumentMetadata;` earlier in the function — reassignment here is already valid.)

Replace the category/subcategory resolution block — everything from `// Normalize category ID & DYNAMICALLY AUTO-CREATE NEW CATEGORY IF NOT FOUND BEFORE MOVING FILE` through the `validated.subcategorie = rawSubSlug;` + `saveCategoriesConfig(categoriesConfig.categories);` at the end of the `else` branch (i.e. everything up to, but not including, the final `logger.info('OLLAMA_AI', \`Classification success\`, ...)` block) with:

```ts
  const { category: matchedCategory, isNew: isNewCategory } = resolveCategory(categoriesConfig, validated.categorie);
  if (isNewCategory) {
    logger.info('OLLAMA_AI', `Auto-created new category '${matchedCategory.id}' for ${filename} BEFORE move`);
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  const { subcategoryId, isNew: isNewSubcategory } = resolveSubcategory(matchedCategory, validated.subcategorie, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST);
  if (isNewSubcategory) {
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${subcategoryId}' under '${matchedCategory.id}' BEFORE move`, { filename });
    saveCategoriesConfig(categoriesConfig.categories);
  } else if (subcategoryId === 'general' && validated.subcategorie !== 'general') {
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug for ${filename} (not found in document content) — forcing 'general' to trigger BLOCK guard`);
  }
  validated.subcategorie = subcategoryId;
```

This preserves the exact same observable behavior: a new category triggers one `saveCategoriesConfig` + info log, a new subcategory triggers another `saveCategoriesConfig` + info log, and the ungrounded-slug case still warns (the warning's exact wording loses the specific rejected slug value, since `resolveSubcategory` doesn't return the pre-'general' raw slug on that path — this is a minor cosmetic log-message difference, not a behavior change to any Golden Rule enforcement or file placement, so it's within this task's "no behavior change" constraint as applied to actual document handling; flag it in your task report as a noted cosmetic deviation).

- [ ] **Step 3: Create `src/domain/classification-resolution.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { refineClassification, resolveCategory, resolveSubcategory } from './classification-resolution.js';
import { DocumentMetadata, CategoryItem, EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['dupond', 'martin', 'lefebvre', 'bernard'];

function baseMetadata(overrides: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    titre: 'Test', registre: '', date: '', categorie: 'administrative', subcategorie: 'general',
    summary: '', tags: [], markdown_content: '', other: {}, ...overrides,
  };
}

describe('refineClassification', () => {
  it('leaves a specific classification untouched', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result).toEqual(input);
  });

  it('replaces categorie "personal" with the rule-based result', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
  });

  it('replaces a "general" subcategorie with the rule-based result when the rule-based classifier finds something specific', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'general' });
    const result = refineClassification(input, 'Facture SFR Total TTC 45.99', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.subcategorie).toBe('sfr');
  });

  it('does not mutate the input object', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(input.categorie).toBe('personal');
  });
});

describe('resolveCategory', () => {
  it('matches an existing category by id', () => {
    const config = { categories: [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] } as CategoryItem] };
    const { category, isNew } = resolveCategory(config, 'invoices');
    expect(category.id).toBe('invoices');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new category when none matches', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category, isNew } = resolveCategory(config, 'new_category');
    expect(isNew).toBe(true);
    expect(category.id).toBe('new_category');
    expect(config.categories).toContain(category);
  });

  it('defaults an empty/falsy categorie to "administrative"', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category } = resolveCategory(config, '');
    expect(category.id).toBe('administrative');
  });
});

describe('resolveSubcategory', () => {
  it('matches an existing subcategory by id', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'sfr', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('sfr');
    expect(isNew).toBe(false);
  });

  it('resolves a forbidden slug (general/other/divers) as-is without creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'other', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('other');
    expect(isNew).toBe(false);
    expect(category.subcategories).toHaveLength(0);
  });

  it('resolves an ungrounded slug to "general" instead of creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'veolia', 'nothing here about that entity', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new subcategory when the slug is genuinely grounded', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew, newSubcategory } = resolveSubcategory(category, 'veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(isNew).toBe(true);
    expect(subcategoryId).toBe('veolia');
    expect(newSubcategory?.id).toBe('veolia');
    expect(category.subcategories).toContainEqual(newSubcategory);
  });

  it('coerces a bare-year subcategorie to "general"', () => {
    const category: CategoryItem = { id: 'administrative', name: 'Administrative', description: '', aliases: [], subcategories: [] };
    const { subcategoryId } = resolveSubcategory(category, '2023', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
  });
});
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, 86 tests (74 + 12 new: 4 `refineClassification` + 3 `resolveCategory` + 5 `resolveSubcategory`). Confirm the exact count by reading Vitest's own summary line rather than trusting this arithmetic.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract refineClassification/resolveCategory/resolveSubcategory to src/domain/classification-resolution.ts"
```

---

## Task 7: `src/infrastructure/logger.ts`

**Files:**
- Create: `src/infrastructure/logger.ts` (relocated from `src/services/logger.service.ts`)
- Delete: `src/services/logger.service.ts`
- Modify: `src/services/pdf.service.ts`, `src/services/triage.service.ts`, `src/services/ai.service.ts`, `src/server/web_server.ts` (import path only)

**Interfaces:**
- Produces: same `logger` export (`{ debug, info, warn, error }`), unchanged content, new import path.

- [ ] **Step 1: Move the file**

```bash
git mv src/services/logger.service.ts src/infrastructure/logger.ts
```

No content changes needed — `logger.service.ts` has no imports of other project files.

- [ ] **Step 2: Update every importer's import path**

In `src/services/pdf.service.ts`, change:
```ts
import { logger } from './logger.service.js';
```
to:
```ts
import { logger } from '../infrastructure/logger.js';
```

In `src/services/triage.service.ts`, change:
```ts
import { logger } from './logger.service.js';
```
to:
```ts
import { logger } from '../infrastructure/logger.js';
```

In `src/services/ai.service.ts`, change:
```ts
import { logger } from './logger.service.js';
```
to:
```ts
import { logger } from '../infrastructure/logger.js';
```

In `src/server/web_server.ts`, change:
```ts
import { logger } from '../services/logger.service.js';
```
to:
```ts
import { logger } from '../infrastructure/logger.js';
```

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests passing (no test imports `logger.service.js` directly).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move logger to src/infrastructure/logger.ts"
```

---

## Task 8: `src/infrastructure/settings.ts`

**Files:**
- Create: `src/infrastructure/settings.ts` (relocated from `src/config.ts`)
- Delete: `src/config.ts`
- Modify: `src/services/ai.service.ts`, `src/services/triage.service.ts`, `src/db/database.ts`, `src/services/json_registry.service.ts`, `src/server/web_server.ts`, `src/index.ts` (import path only)
- Create: `src/infrastructure/settings.test.ts` (relocated from `src/config.test.ts`)
- Delete: `src/config.test.ts`

**Interfaces:**
- Produces: same exports (`BASE_DIR`, `SETTINGS_FILE`, `loadCustomSettings`, `CONFIG`, `reloadConfigFromDisk`, `updateConfig`, `ensureDirectoriesExist`), unchanged content, new import path `../infrastructure/settings.js` (or `./settings.js` for files already inside `src/infrastructure/`, or `./infrastructure/settings.js` for `index.ts`).

**Correction (found during execution):** this step originally listed only 4 importers and said "5 occurrences" in the test file, and said `index.ts` would be handled later in Task 25. All three of those were wrong — verified against the actual codebase: (1) `src/services/json_registry.service.ts` also imports `CONFIG` from `../config.js` and was missing from the list; (2) the test file has 8 dynamic-import occurrences, not 5 (3 in `loadCustomSettings`, 3 in `CONFIG derivation`, 1 in `updateConfig`, 1 in `reloadConfigFromDisk`); (3) deferring `index.ts` to Task 25 breaks `npm run build` for every task from this one through Task 24, since `index.ts` imports `./config.js` directly and that path stops existing the moment this task's `git mv` runs — the same landmine Task 20 already correctly avoided for `runTriageScan` by fixing `index.ts`'s import in the same task that moved it. This task now fixes `index.ts`'s `CONFIG`/`BASE_DIR`/`ensureDirectoriesExist` import too, following that same pattern. (Tasks 23 and 24 have matching corrections for their own `index.ts` dependency.)

- [ ] **Step 1: Move the files**

```bash
git mv src/config.ts src/infrastructure/settings.ts
git mv src/config.test.ts src/infrastructure/settings.test.ts
```

No content changes needed in `settings.ts` itself — `config.ts` has no imports of other project files besides `fs`/`path`.

In `src/infrastructure/settings.test.ts`, change every occurrence of `await import('./config.js')` to `await import('./settings.js')`. Grep the file for `config.js` after editing to confirm none remain — there are 8 occurrences (one per `it` block across all 4 describe blocks), not the 5 an earlier draft of this brief claimed.

- [ ] **Step 2: Update every importer's import path**

In `src/services/ai.service.ts`, change:
```ts
import { CONFIG } from '../config.js';
```
to:
```ts
import { CONFIG } from '../infrastructure/settings.js';
```

In `src/services/triage.service.ts`, change:
```ts
import { CONFIG, BASE_DIR, ensureDirectoriesExist, reloadConfigFromDisk } from '../config.js';
```
to:
```ts
import { CONFIG, BASE_DIR, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
```

In `src/db/database.ts`, change:
```ts
import { CONFIG } from '../config.js';
```
to:
```ts
import { CONFIG } from '../infrastructure/settings.js';
```

In `src/services/json_registry.service.ts`, change:
```ts
import { CONFIG } from '../config.js';
```
to:
```ts
import { CONFIG } from '../infrastructure/settings.js';
```

In `src/server/web_server.ts`, change:
```ts
import { CONFIG, BASE_DIR, updateConfig } from '../config.js';
```
to:
```ts
import { CONFIG, BASE_DIR, updateConfig } from '../infrastructure/settings.js';
```

In `src/index.ts`, change:
```ts
import { ensureDirectoriesExist, CONFIG } from './config.js';
```
to:
```ts
import { ensureDirectoriesExist, CONFIG } from './infrastructure/settings.js';
```
(`index.ts`'s other two imports — `startWebServer` from `./server/web_server.js` and `startMCPServer` from `./mcp/server.js` — are untouched here; those move in Tasks 23/24 respectively, each fixing its own `index.ts` line in its own task, same pattern as this one.)

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests passing (the settings tests now run from `src/infrastructure/settings.test.ts`, same 8 test cases, same assertions).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move config.ts to src/infrastructure/settings.ts, update all importers incl. index.ts"
```

---

## Task 9: `src/infrastructure/db/database.ts`

**Files:**
- Create: `src/infrastructure/db/database.ts` (relocated from `src/db/database.ts`)
- Delete: `src/db/database.ts`
- Modify: `src/services/triage.service.ts`, `src/services/json_registry.service.ts`, `src/server/web_server.ts`, `src/mcp/server.ts` (import path only)

**Interfaces:**
- Produces: same exports (`getDb`, `DocumentRecord`, `insertDocumentRecord`, `updateDocumentRecord`, `getAllDocuments`, `getDocumentById`, `getDocumentByChecksum`, `getCategorySubcategoryStats`), unchanged content, new import path.

- [ ] **Step 1: Move the file**

```bash
git mv src/db/database.ts src/infrastructure/db/database.ts
```

Update its own internal import — change:
```ts
import { CONFIG } from '../config.js';
```
to:
```ts
import { CONFIG } from '../settings.js';
```

- [ ] **Step 2: Update every importer's import path**

In `src/services/triage.service.ts`, change:
```ts
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getAllDocuments, getDb, getDocumentById } from '../db/database.js';
```
to:
```ts
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getAllDocuments, getDb, getDocumentById } from '../infrastructure/db/database.js';
```

In `src/services/json_registry.service.ts`, change:
```ts
import { getAllDocuments, DocumentRecord } from '../db/database.js';
```
to:
```ts
import { getAllDocuments, DocumentRecord } from '../infrastructure/db/database.js';
```

In `src/server/web_server.ts`, change:
```ts
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../db/database.js';
```
to:
```ts
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../infrastructure/db/database.js';
```

In `src/mcp/server.ts`, change:
```ts
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../db/database.js';
```
to:
```ts
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
```

- [ ] **Step 3: Remove the now-empty `src/db/` directory**

Verify with `ls src/db` that it's gone after the `git mv` (no files left in it).

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests (no test imports `db/database.js` directly today).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move database.ts to src/infrastructure/db/database.ts"
```

---

## Task 10: `src/infrastructure/json-registry.ts`

**Files:**
- Create: `src/infrastructure/json-registry.ts` (relocated from `src/services/json_registry.service.ts`)
- Delete: `src/services/json_registry.service.ts`
- Modify: `src/services/triage.service.ts`, `src/server/web_server.ts`, `src/mcp/server.ts` (import path only)

**Interfaces:**
- Produces: same exports (`JSONRegistryEntry`, `syncJSONRegistry`), unchanged content, new import path.

- [ ] **Step 1: Move the file**

```bash
git mv src/services/json_registry.service.ts src/infrastructure/json-registry.ts
```

Update its own internal imports — change:
```ts
import fs from 'fs';
import { CONFIG } from '../config.js';
import { getAllDocuments, DocumentRecord } from '../db/database.js';
```
to:
```ts
import fs from 'fs';
import { CONFIG } from './settings.js';
import { getAllDocuments, DocumentRecord } from './db/database.js';
```

- [ ] **Step 2: Update every importer's import path**

In `src/services/triage.service.ts`, change:
```ts
import { syncJSONRegistry } from './json_registry.service.js';
```
to:
```ts
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
```

In `src/server/web_server.ts`, change:
```ts
import { syncJSONRegistry } from '../services/json_registry.service.js';
```
to:
```ts
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
```

In `src/mcp/server.ts`, change:
```ts
import { syncJSONRegistry } from '../services/json_registry.service.js';
```
to:
```ts
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
```

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move json_registry.service.ts to src/infrastructure/json-registry.ts"
```

---

## Task 11: `src/infrastructure/categories-store.ts`

**Files:**
- Create: `src/infrastructure/categories-store.ts`
- Modify: `src/services/ai.service.ts`, `src/services/triage.service.ts`, `src/server/web_server.ts`, `src/mcp/server.ts` (remove local definitions / update import path)

**Interfaces:**
- Produces: `getCategoriesConfig(): { categories: CategoryItem[] }`, `saveCategoriesConfig(categories: CategoryItem[]): void`, `setOnCategoryCreatedCallback(cb: () => void): void` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/infrastructure/categories-store.ts`**

```ts
import fs from 'fs';
import { CONFIG } from './settings.js';
import { CategoriesConfigSchema, CategoryItem } from '../domain/document.schema.js';

export function getCategoriesConfig() {
  if (fs.existsSync(CONFIG.CATEGORIES_FILE)) {
    const raw = fs.readFileSync(CONFIG.CATEGORIES_FILE, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      return CategoriesConfigSchema.parse(parsed);
    } catch (e) {
      console.error("Invalid categories.json schema, using defaults", e);
    }
  }
  return {
    categories: [
      { id: 'invoices', name: 'Factures', description: 'Factures et reçus', aliases: ['facture', 'invoice'], subcategories: [] },
      { id: 'bulletin_salaire', name: 'Bulletins de Salaire', description: 'Fiches de paie par entreprise', aliases: ['bulletin_salaire', 'paie', 'salaire'], subcategories: [] },
      { id: 'contracts', name: 'Contrats', description: 'Contrats et baux', aliases: ['contrat', 'contract'], subcategories: [] },
      { id: 'administrative', name: 'Administratif', description: 'Documents administratifs', aliases: ['tax', 'impot'], subcategories: [] },
      { id: 'health', name: 'Santé', description: 'Santé et mutuelle', aliases: ['health', 'sante'], subcategories: [] },
      { id: 'identity', name: 'Identité', description: 'Passeports et cartes d identite', aliases: ['identity', 'passport'], subcategories: [] },
      { id: 'housing', name: 'Logement', description: 'Justificatifs de domicile et loyers', aliases: ['housing', 'logement'], subcategories: [] },
      { id: 'insurance', name: 'Assurances', description: 'Contrats d assurance', aliases: ['insurance', 'assurance'], subcategories: [] },
      { id: 'education', name: 'Éducation', description: 'Formations et diplômes', aliases: ['education', 'formation'], subcategories: [] },
      { id: 'recruitment', name: 'Recrutement', description: 'Lettres et CV', aliases: ['recrutement', 'candidature'], subcategories: [] },
      { id: 'correspondence', name: 'Courriers', description: 'Emails et lettres', aliases: ['courrier', 'mail'], subcategories: [] },
      { id: 'technical', name: 'Technique', description: 'Manuels et guides', aliases: ['tech', 'manual'], subcategories: [] },
      { id: 'reports', name: 'Rapports', description: 'Rapports de projets', aliases: ['report'], subcategories: [] }
    ]
  };
}

export let onCategoryCreatedCallback: (() => void) | null = null;
export function setOnCategoryCreatedCallback(cb: () => void) {
  onCategoryCreatedCallback = cb;
}

export function saveCategoriesConfig(categories: CategoryItem[]): void {
  const validated = CategoriesConfigSchema.parse({ categories });
  fs.writeFileSync(CONFIG.CATEGORIES_FILE, JSON.stringify(validated, null, 2), 'utf-8');
  if (onCategoryCreatedCallback) {
    try { onCategoryCreatedCallback(); } catch (e) {}
  }
}
```

- [ ] **Step 2: Remove these from `src/services/ai.service.ts`, import them back**

Delete the `getCategoriesConfig`, `onCategoryCreatedCallback`/`setOnCategoryCreatedCallback`, `saveCategoriesConfig` definitions from `ai.service.ts`.

Add to the imports:
```ts
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
```

(`ai.service.ts` doesn't call `setOnCategoryCreatedCallback` itself — only `web_server.ts` does — so it isn't re-imported here.)

- [ ] **Step 3: Update `src/services/triage.service.ts`'s import**

`triage.service.ts` currently has two import lines touching these names (from Task 4's fix): `import { classifyPDFText, generateEmbedding, getCategoriesConfig, saveCategoriesConfig, getEntityDictionary } from './ai.service.js';` and a separate `import { ruleBasedClassify } from '../domain/classification.js';` (unaffected by this task). Change the first line:
```ts
import { classifyPDFText, generateEmbedding, getCategoriesConfig, saveCategoriesConfig, getEntityDictionary } from './ai.service.js';
```
to:
```ts
import { classifyPDFText, generateEmbedding, getEntityDictionary } from './ai.service.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
```

- [ ] **Step 4: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback, checkModelCanGenerate } from '../services/ai.service.js';
```
to:
```ts
import { checkModelCanGenerate } from '../services/ai.service.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../infrastructure/categories-store.js';
```

- [ ] **Step 5: Update `src/mcp/server.ts`'s import**

Change:
```ts
import { getCategoriesConfig } from '../services/ai.service.js';
```
to:
```ts
import { getCategoriesConfig } from '../infrastructure/categories-store.js';
```

- [ ] **Step 6: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests (nothing in the test suite calls `getCategoriesConfig`/`saveCategoriesConfig` directly today — `classifyPDFText`'s tests exercise it indirectly via `fs` mocks, which still work identically since the underlying `fs.existsSync`/`readFileSync` calls are unchanged, just relocated).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract categories.json read/write to src/infrastructure/categories-store.ts"
```

---

## Task 12: `src/infrastructure/entity-dictionary-store.ts`

**Files:**
- Create: `src/infrastructure/entity-dictionary-store.ts`
- Modify: `src/services/ai.service.ts`, `src/services/triage.service.ts` (remove local definition / update import path)

**Interfaces:**
- Produces: `getEntityDictionary(): EntityDictionary` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/infrastructure/entity-dictionary-store.ts`**

```ts
import fs from 'fs';
import { CONFIG } from './settings.js';
import { EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';

export function getEntityDictionary(): EntityDictionary {
  if (fs.existsSync(CONFIG.ENTITY_DICTIONARY_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG.ENTITY_DICTIONARY_FILE, 'utf-8');
      return EntityDictionarySchema.parse(JSON.parse(raw));
    } catch (e) {
      console.error("Invalid entity_dictionary.json schema, using empty dictionary", e);
    }
  }
  return EntityDictionarySchema.parse({});
}
```

- [ ] **Step 2: Remove it from `src/services/ai.service.ts`, import it back**

Delete the `getEntityDictionary` function from `ai.service.ts`.

Add to the imports:
```ts
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
```

- [ ] **Step 3: Update `src/services/triage.service.ts`'s import**

After Task 11, `triage.service.ts` has `import { classifyPDFText, generateEmbedding, getEntityDictionary } from './ai.service.js';` (plus the separate `ruleBasedClassify`/`getCategoriesConfig`/`saveCategoriesConfig` import lines from Tasks 4/11, unaffected here). Change:
```ts
import { classifyPDFText, generateEmbedding, getEntityDictionary } from './ai.service.js';
```
to:
```ts
import { classifyPDFText, generateEmbedding } from './ai.service.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract entity_dictionary.json read to src/infrastructure/entity-dictionary-store.ts"
```

---

## Task 13: `src/infrastructure/ollama-client.ts`

**Files:**
- Create: `src/infrastructure/ollama-client.ts`
- Modify: `src/services/ai.service.ts` (remove local definitions, rewrite `classifyPDFText`'s Ollama call to use the new wrapper)
- Modify: `src/server/web_server.ts` (import path for `checkModelCanGenerate`)
- Modify: `src/services/triage.service.ts` (import path for `generateEmbedding`) — **correction found during execution:** this file also imports `generateEmbedding` from `ai.service.js` and was missing from this list; split its `ai.service.js` import line the same way `web_server.ts`'s is split in Step 3.

**Interfaces:**
- Produces: `checkModelCanGenerate(modelName: string, host?: string, forceRefresh?: boolean): Promise<{ ok: boolean; error?: string }>`, `ensureOllamaModel(modelName?: string): Promise<boolean>`, `generateEmbedding(text: string): Promise<number[]>` — unchanged behavior, new location. Plus new: `requestClassificationCompletion(system: string, user: string): Promise<{ response: string; thinking?: string }>`.

- [ ] **Step 1: Create `src/infrastructure/ollama-client.ts`**

```ts
import { Ollama } from 'ollama';
import { CONFIG } from './settings.js';

interface ModelHealthCacheEntry {
  modelName: string;
  checkedAt: number;
  canGenerate: boolean;
  error?: string;
}
let modelHealthCache: ModelHealthCacheEntry | null = null;
const MODEL_HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;

// A model can pass the "exists locally" check (ollama.list()) yet still be unable to
// generate — e.g. a cloud/subscription-gated model that's listed but rejects requests
// at generate-time. This does a cheap 1-token generation to catch that proactively,
// cached briefly so it isn't repeated on every single document classification.
export async function checkModelCanGenerate(modelName: string, host: string = CONFIG.OLLAMA_HOST, forceRefresh = false): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  if (!forceRefresh && modelHealthCache && modelHealthCache.modelName === modelName && (now - modelHealthCache.checkedAt) < MODEL_HEALTH_CACHE_TTL_MS) {
    return { ok: modelHealthCache.canGenerate, error: modelHealthCache.error };
  }
  const ollama = new Ollama({ host });
  try {
    await ollama.generate({ model: modelName, prompt: 'test', options: { num_predict: 1 } });
    modelHealthCache = { modelName, checkedAt: now, canGenerate: true };
    return { ok: true };
  } catch (err: any) {
    modelHealthCache = { modelName, checkedAt: now, canGenerate: false, error: err.message };
    return { ok: false, error: err.message };
  }
}

export async function ensureOllamaModel(modelName: string = CONFIG.OLLAMA_MODEL): Promise<boolean> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const list = await ollama.list();
    const exists = list.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
    if (!exists) {
      console.log(`Model '${modelName}' not found locally in Ollama. Pulling '${modelName}'...`);
      await ollama.pull({ model: modelName });
      console.log(`Model '${modelName}' pulled successfully.`);
    }
    const health = await checkModelCanGenerate(modelName);
    if (!health.ok) {
      console.warn(`Model '${modelName}' exists locally but cannot generate (e.g. subscription-gated cloud model): ${health.error}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`Ollama check/pull warning for model ${modelName}:`, err.message);
    try {
      console.log('Attempting auto-spawn of local Ollama serve process...');
      const { exec } = await import('child_process');
      exec('ollama serve');
      await new Promise(r => setTimeout(r, 2000));
      const retryList = await ollama.list();
      const existsAfterSpawn = retryList.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
      if (!existsAfterSpawn) return false;
      const health = await checkModelCanGenerate(modelName, CONFIG.OLLAMA_HOST, true);
      return health.ok;
    } catch (autoErr: any) {
      console.error('Failed to auto-spawn Ollama:', autoErr.message);
      return false;
    }
  }
}

// Thin wrapper around the raw classification generate() call — think:false is required
// here: qwen3.5:9b is a thinking-capable model that otherwise routes its whole JSON
// answer into response.thinking and leaves response.response empty (see the regression
// test in src/application/classify-document.test.ts).
export async function requestClassificationCompletion(system: string, user: string): Promise<{ response: string; thinking?: string }> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const result: any = await ollama.generate({
    model: CONFIG.OLLAMA_MODEL,
    system,
    prompt: user,
    format: 'json',
    think: false,
    options: {
      temperature: 0.1,
      num_ctx: 8192,
      num_predict: 4096
    }
  });
  return { response: result.response, thinking: result.thinking };
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const response = await ollama.embeddings({
      model: CONFIG.OLLAMA_EMBED_MODEL,
      prompt: text.substring(0, 1000)
    });
    return response.embedding || [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Remove these from `src/services/ai.service.ts`, rewrite `classifyPDFText`'s Ollama call**

Delete `checkModelCanGenerate`, `ensureOllamaModel`, `generateEmbedding` from `ai.service.ts`. Remove the `import { Ollama } from 'ollama';` line entirely (nothing in `ai.service.ts` uses `Ollama` directly anymore after this task).

Add to the imports:
```ts
import { ensureOllamaModel, requestClassificationCompletion } from '../infrastructure/ollama-client.js';
```

Inside `classifyPDFText`, change the top of the function from:
```ts
export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);
```
to:
```ts
export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);
```

Change the generate call — from:
```ts
    const response = await ollama.generate({
      model: CONFIG.OLLAMA_MODEL,
      system: systemPrompt,
      prompt: userPrompt,
      format: 'json',
      // qwen3.5:9b is a thinking-capable model; without this, it routes its entire
      // JSON answer into response.thinking and leaves response.response empty.
      think: false,
      options: {
        temperature: 0.1,
        num_ctx: 8192,
        num_predict: 4096
      }
    });

    const rawResp = response.response.trim();
```
to:
```ts
    const response = await requestClassificationCompletion(systemPrompt, userPrompt);

    const rawResp = response.response.trim();
```

- [ ] **Step 3: Update `checkModelCanGenerate`'s import in `src/server/web_server.ts`**

Change:
```ts
import { checkModelCanGenerate } from '../services/ai.service.js';
```
to:
```ts
import { checkModelCanGenerate } from '../infrastructure/ollama-client.js';
```

`web_server.ts` also has its own top-level `import { Ollama } from 'ollama';` for the `/api/ollama/status` route — this is unrelated to `ai.service.ts`'s usage and stays as-is; this task doesn't touch it.

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests. The `classifyPDFText` tests in `src/services/ai.service.test.ts` mock the `ollama` npm package itself (not a specific file's import of it), so they continue to pass unchanged — `requestClassificationCompletion` still ultimately calls `new Ollama(...).generate(...)`, in the same call order (health-probe first via `ensureOllamaModel`, classification request second), so the existing `toHaveBeenNthCalledWith(2, expect.objectContaining({ think: false }))` assertion still holds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract Ollama client calls to src/infrastructure/ollama-client.ts"
```

---

## Task 14: `src/infrastructure/pdf-extractor.ts`

**Files:**
- Create: `src/infrastructure/pdf-extractor.ts` (relocated from `src/services/pdf.service.ts`)
- Delete: `src/services/pdf.service.ts` (empty after this — its only remaining content, since `cleanExtractedText` left in Task 1)
- Modify: `src/services/triage.service.ts` (import path only)

**Interfaces:**
- Produces: `ExtractedPDF` interface, `extractPDFContent(filePath: string): Promise<ExtractedPDF>` — unchanged behavior, new location.

- [ ] **Step 1: Move the file**

```bash
git mv src/services/pdf.service.ts src/infrastructure/pdf-extractor.ts
```

Update its internal imports — change:
```ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import { logger } from '../infrastructure/logger.js';
import { cleanExtractedText } from '../domain/pdf-text.js';
```
to:
```ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import { logger } from './logger.js';
import { cleanExtractedText } from '../domain/pdf-text.js';
```

(Only the `logger` import path changes — it's now a sibling file in `src/infrastructure/` instead of one directory up.)

- [ ] **Step 2: Update `src/services/triage.service.ts`'s import**

Change:
```ts
import { extractPDFContent } from './pdf.service.js';
```
to:
```ts
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
```

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests. `src/services/` now contains only `triage.service.ts` and `ai.service.ts`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move pdf.service.ts to src/infrastructure/pdf-extractor.ts"
```

---

## Task 15: `src/infrastructure/pdf-scanner.ts`

**Files:**
- Create: `src/infrastructure/pdf-scanner.ts`
- Modify: `src/services/triage.service.ts` (remove the 2 functions, import them back)
- Modify: `src/server/web_server.ts` (import path for `getPDFsRecursively`)

**Interfaces:**
- Consumes: `isPathInsideDir` from `src/domain/taxonomy.js` (Task 3).
- Produces: `getPDFsRecursively(dir: string, ignoreDir?: string): string[]`, `getAllFilesRecursively(dir: string): string[]` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/infrastructure/pdf-scanner.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { isPathInsideDir } from '../domain/taxonomy.js';

export function getPDFsRecursively(dir: string, ignoreDir?: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (ignoreDir && isPathInsideDir(fullPath, ignoreDir)) {
      continue;
    }

    if (item.isDirectory()) {
      results = results.concat(getPDFsRecursively(fullPath, ignoreDir));
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function getAllFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getAllFilesRecursively(fullPath));
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }
  return results;
}
```

- [ ] **Step 2: Remove these from `src/services/triage.service.ts`, import them back**

Delete `getPDFsRecursively` and `getAllFilesRecursively` from `triage.service.ts`.

Add to the imports:
```ts
import { getPDFsRecursively, getAllFilesRecursively } from '../infrastructure/pdf-scanner.js';
```

- [ ] **Step 3: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, getPDFsRecursively, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws, ensureCategoryAndSubcategoryExist } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws, ensureCategoryAndSubcategoryExist } from '../services/triage.service.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract getPDFsRecursively/getAllFilesRecursively to src/infrastructure/pdf-scanner.ts"
```

---

## Task 16: `src/infrastructure/pid-lock.ts` (new — DRY consolidation)

Consolidates the near-duplicate PID-lock-file logic in `triage.service.ts`'s `acquireScanLock` and `web_server.ts`'s `acquireSingleInstanceLock`. Both keep their current behavior exactly (one throws `ScanInProgressError` and returns a manual-release closure; the other calls `process.exit(1)` and auto-registers signal handlers) — only the shared "is this lock file held by a live other process, and read/write/release it" mechanics move into one place.

**Files:**
- Create: `src/infrastructure/pid-lock.ts`
- Modify: `src/services/triage.service.ts` (replace `isLockHolderRunning` + the lock-file check/write inside `acquireScanLock`)
- Modify: `src/server/web_server.ts` (replace `isProcessRunning` + the lock-file check/write inside `acquireSingleInstanceLock`)

**Interfaces:**
- Produces: `isProcessRunning(pid: number): boolean`, `readActiveLockHolder(lockFilePath: string): number | null` (returns the PID if the lock is held by a still-running *other* process, else `null`), `acquireProcessLock(lockFilePath: string): () => void` (writes this process's PID, returns a release closure that only deletes the file if it still belongs to this process).

- [ ] **Step 1: Create `src/infrastructure/pid-lock.ts`**

```ts
import fs from 'fs';

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

// Returns the existing lock holder's PID if the lock is currently held by a still-running
// OTHER process, or null if the lock is free, stale (holder no longer running), or held
// by this same process.
export function readActiveLockHolder(lockFilePath: string): number | null {
  if (!fs.existsSync(lockFilePath)) return null;
  const existingPid = parseInt(fs.readFileSync(lockFilePath, 'utf-8').trim(), 10);
  if (!isNaN(existingPid) && existingPid !== process.pid && isProcessRunning(existingPid)) {
    return existingPid;
  }
  return null;
}

// Writes this process's PID to lockFilePath and returns a release function that removes
// the lock file — but only if it still belongs to this process (avoids deleting a lock
// another process has since acquired).
export function acquireProcessLock(lockFilePath: string): () => void {
  fs.writeFileSync(lockFilePath, String(process.pid), 'utf-8');
  return () => {
    try {
      if (fs.existsSync(lockFilePath) && fs.readFileSync(lockFilePath, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch (e) {}
  };
}
```

- [ ] **Step 2: Rewrite `acquireScanLock` in `src/services/triage.service.ts`**

Delete the `isLockHolderRunning` function. Change:
```ts
function acquireScanLock(): () => void {
  if (fs.existsSync(SCAN_LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(SCAN_LOCK_FILE, 'utf-8').trim(), 10);
    if (!isNaN(existingPid) && existingPid !== process.pid && isLockHolderRunning(existingPid)) {
      throw new ScanInProgressError(existingPid);
    }
  }
  fs.writeFileSync(SCAN_LOCK_FILE, String(process.pid), 'utf-8');
  return () => {
    try {
      if (fs.existsSync(SCAN_LOCK_FILE) && fs.readFileSync(SCAN_LOCK_FILE, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(SCAN_LOCK_FILE);
      }
    } catch (e) {}
  };
}
```
to:
```ts
function acquireScanLock(): () => void {
  const holderPid = readActiveLockHolder(SCAN_LOCK_FILE);
  if (holderPid !== null) {
    throw new ScanInProgressError(holderPid);
  }
  return acquireProcessLock(SCAN_LOCK_FILE);
}
```

Add to the imports:
```ts
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';
```

- [ ] **Step 3: Rewrite `acquireSingleInstanceLock` in `src/server/web_server.ts`**

Delete the `isProcessRunning` function. Change:
```ts
function acquireSingleInstanceLock(): void {
  if (fs.existsSync(PID_LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_LOCK_FILE, 'utf-8').trim(), 10);
    if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
      console.error(`Another instance of this server is already running (PID ${existingPid}). Refusing to start a second instance — stop it first, or delete ${PID_LOCK_FILE} if it's stale.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(PID_LOCK_FILE, String(process.pid), 'utf-8');

  const releaseLock = () => {
    try {
      if (fs.existsSync(PID_LOCK_FILE) && fs.readFileSync(PID_LOCK_FILE, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(PID_LOCK_FILE);
      }
    } catch (e) {}
  };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
}
```
to:
```ts
function acquireSingleInstanceLock(): void {
  const holderPid = readActiveLockHolder(PID_LOCK_FILE);
  if (holderPid !== null) {
    console.error(`Another instance of this server is already running (PID ${holderPid}). Refusing to start a second instance — stop it first, or delete ${PID_LOCK_FILE} if it's stale.`);
    process.exit(1);
  }

  const releaseLock = acquireProcessLock(PID_LOCK_FILE);
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
}
```

Add to the imports:
```ts
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';
```

(Note: `web_server.ts`'s top-level `import fs from 'fs';` is still needed for other routes in this file — e.g. `/api/open-location`, the public-dir static check — so it stays.)

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: consolidate duplicate PID-lock logic into src/infrastructure/pid-lock.ts"
```

---

## Task 17: `src/application/classify-document.ts`

Everything left in `ai.service.ts` at this point is `classifyPDFText` itself — this task moves it out, which empties the file, so it's deleted entirely.

**Files:**
- Create: `src/application/classify-document.ts`
- Delete: `src/services/ai.service.ts`
- Modify: `src/services/triage.service.ts` (import path for `classifyPDFText`)
- Create: `src/application/classify-document.test.ts` (relocated from the remainder of `src/services/ai.service.test.ts`)
- Delete: `src/services/ai.service.test.ts`

**Interfaces:**
- Consumes: everything extracted in Tasks 2, 4, 5, 6, 11, 12, 13.
- Produces: `classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata>` — unchanged behavior and signature, new location.

- [ ] **Step 1: Create `src/application/classify-document.ts`**

At this point `src/services/ai.service.ts` contains only `classifyPDFText` plus its import block. Move the whole function verbatim to the new file, with this import block:

```ts
import { CONFIG } from '../infrastructure/settings.js';
import { DocumentMetadataSchema, DocumentMetadata } from '../domain/document.schema.js';
import { logger } from '../infrastructure/logger.js';
import { cleanAndParseJSON, ruleBasedClassify, buildCategoriesDescriptionStr } from '../domain/classification.js';
import { buildClassificationPrompt } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory } from '../domain/classification-resolution.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { ensureOllamaModel, requestClassificationCompletion } from '../infrastructure/ollama-client.js';

export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

  const categoriesConfig = getCategoriesConfig();
  const dictionary = getEntityDictionary();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig, dictionary);

  const { system: systemPrompt, user: userPromptBuilt } = buildClassificationPrompt(categoriesDescriptionStr, filename, rawText, previousError);
  let userPrompt = userPromptBuilt;

  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, rawTextLength: rawText.length });

  let validated: DocumentMetadata;

  try {
    if (!modelHealthy) {
      throw new Error(`Model '${CONFIG.OLLAMA_MODEL}' failed its capability check (exists but cannot generate, e.g. a subscription-gated cloud model) — skipping the classification request.`);
    }

    const response = await requestClassificationCompletion(systemPrompt, userPrompt);

    const rawResp = response.response.trim();
    const parsed = cleanAndParseJSON(rawResp);
    validated = DocumentMetadataSchema.parse(parsed);

  } catch (err: any) {
    logger.warn('OLLAMA_AI', `Ollama AI request failed for ${filename}: ${err.message}. Using rule-based classifier.`);
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    validated = DocumentMetadataSchema.parse({
      titre: rb.title,
      registre: '',
      date: rb.date,
      categorie: rb.categorie,
      subcategorie: rb.subcategorie,
      summary: `Document: ${rb.title}.`,
      tags: [rb.categorie, rb.subcategorie].filter(Boolean),
      markdown_content: `# ${rb.title}\n\n${rawText}`
    });
  }

  validated = refineClassification(validated, rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);

  const { category: matchedCategory, isNew: isNewCategory } = resolveCategory(categoriesConfig, validated.categorie);
  if (isNewCategory) {
    logger.info('OLLAMA_AI', `Auto-created new category '${matchedCategory.id}' for ${filename} BEFORE move`);
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  const { subcategoryId, isNew: isNewSubcategory } = resolveSubcategory(matchedCategory, validated.subcategorie, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST);
  if (isNewSubcategory) {
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${subcategoryId}' under '${matchedCategory.id}' BEFORE move`, { filename });
    saveCategoriesConfig(categoriesConfig.categories);
  } else if (subcategoryId === 'general' && validated.subcategorie !== 'general') {
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug for ${filename} (not found in document content) — forcing 'general' to trigger BLOCK guard`);
  }
  validated.subcategorie = subcategoryId;

  logger.info('OLLAMA_AI', `Classification success`, {
    filename,
    title: validated.titre,
    category: validated.categorie,
    subcategory: validated.subcategorie,
    date: validated.date
  });

  return validated;
}
```

Delete `src/services/ai.service.ts`.

- [ ] **Step 2: Update `src/services/triage.service.ts`'s import**

Change:
```ts
import { classifyPDFText, generateEmbedding } from './ai.service.js';
```
to:
```ts
import { classifyPDFText } from '../application/classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
```

- [ ] **Step 3: Relocate the test file**

```bash
git mv src/services/ai.service.test.ts src/application/classify-document.test.ts
```

In `src/application/classify-document.test.ts`, change every `await import('./ai.service.js')` (3 occurrences, one per `it` block) to `await import('./classify-document.js')`.

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests (the 3 `classifyPDFText` tests now run from `src/application/classify-document.test.ts`). `src/services/` now contains only `triage.service.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move classifyPDFText to src/application/classify-document.ts, delete ai.service.ts"
```

---

## Task 18: `src/application/relocalize-document.ts`

**Files:**
- Create: `src/application/relocalize-document.ts`
- Modify: `src/services/triage.service.ts` (remove the 5 functions, import them back)
- Modify: `src/server/web_server.ts`, `src/mcp/server.ts` (import path)

**Interfaces:**
- Consumes: `computeCanonicalPath` from `src/domain/taxonomy.js`; `isForbiddenSubcategory` from `src/domain/taxonomy.js`; `getPDFsRecursively` from `src/infrastructure/pdf-scanner.js`; `getCategoriesConfig`/`saveCategoriesConfig` from `src/infrastructure/categories-store.js`; `extractPDFContent` from `src/infrastructure/pdf-extractor.js`; `classifyPDFText` from `src/application/classify-document.js` (Task 17); `syncJSONRegistry` from `src/infrastructure/json-registry.js`; `getDb`, `getDocumentByChecksum`, `getDocumentById`, `updateDocumentRecord` from `src/infrastructure/db/database.js`; `CONFIG` from `src/infrastructure/settings.js`; `logger` from `src/infrastructure/logger.js`.
- Produces: `relocalizeFileIfNeeded(filePath: string, category: string, subcategory?: string, dateStr?: string): { newPath: string; moved: boolean }`, `moveBackToRaws(filePath: string, checksum?: string): Promise<string>`, `findActualFileOnDisk(doc: {...}): string | null`, `ensureCategoryAndSubcategoryExist(category: string, subcategory: string): void`, `reclassifyAndRelocalizeDocument(id, explicitCategory?, explicitSubcategory?, userFeedbackReason?): Promise<{...}>` — all unchanged behavior, new location.

- [ ] **Step 1: Create `src/application/relocalize-document.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { computeCanonicalPath, isForbiddenSubcategory } from '../domain/taxonomy.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { classifyPDFText } from './classify-document.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { getDb, getDocumentByChecksum, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
import { logger } from '../infrastructure/logger.js';

// Moves sourcePath to desiredTargetPath without the check-then-act race a plain
// `existsSync` + `renameSync` has: fs.linkSync fails atomically with EEXIST if the
// target already exists (unlike renameSync, which would silently overwrite it on
// Windows), so a genuine collision always gets a fresh unique suffix instead of
// clobbering another file. Falls back to a plain rename across filesystem/volume
// boundaries (EXDEV), where an atomic link isn't possible.
function renameAtomicNoOverwrite(sourcePath: string, desiredTargetPath: string, maxAttempts = 20): string {
  const dir = path.dirname(desiredTargetPath);
  const ext = path.extname(desiredTargetPath);
  const base = path.basename(desiredTargetPath, ext);

  let candidate = desiredTargetPath;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.linkSync(sourcePath, candidate);
      fs.unlinkSync(sourcePath);
      return candidate;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        candidate = path.join(dir, `${base}_${Date.now()}_${attempt}${ext}`);
        continue;
      }
      if (err.code === 'EXDEV') {
        fs.renameSync(sourcePath, candidate);
        return candidate;
      }
      throw err;
    }
  }
  throw new Error(`Failed to move '${sourcePath}' to a unique path after ${maxAttempts} attempts`);
}

export function relocalizeFileIfNeeded(
  filePath: string,
  category: string,
  subcategory?: string,
  dateStr?: string
): { newPath: string; moved: boolean } {
  const targetPath = computeCanonicalPath(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr);

  const normTarget = path.normalize(targetPath).toLowerCase();
  const normCurrent = path.normalize(filePath).toLowerCase();

  if (normTarget === normCurrent) {
    return { newPath: filePath, moved: false };
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  logger.info('RELOCALIZE', `Relocalizing document to canonical subcategory path`, { from: filePath, to: targetPath });
  const finalTarget = renameAtomicNoOverwrite(filePath, targetPath);

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return { newPath: finalTarget, moved: true };
}

export async function moveBackToRaws(filePath: string, checksum?: string): Promise<string> {
  const filename = path.basename(filePath);
  const desiredTargetPath = path.join(CONFIG.INPUT_DIR, filename);

  logger.warn('REPAIR', `Moving file '${filename}' back to __raws`, { targetPath: desiredTargetPath });
  const targetPath = path.normalize(desiredTargetPath).toLowerCase() === path.normalize(filePath).toLowerCase()
    ? filePath
    : renameAtomicNoOverwrite(filePath, desiredTargetPath);

  if (checksum) {
    const existing = await getDocumentByChecksum(checksum);
    if (existing) {
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [existing.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [existing.id]);
      } catch (e) {}
    }
  }

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return targetPath;
}

export function findActualFileOnDisk(doc: { original_filename?: string; original_path?: string; new_path?: string }): string | null {
  if (doc.new_path && fs.existsSync(doc.new_path)) {
    return doc.new_path;
  }
  if (doc.original_path && fs.existsSync(doc.original_path)) {
    return doc.original_path;
  }

  const filename = doc.original_filename || (doc.original_path ? path.basename(doc.original_path) : '');
  if (!filename) return null;

  const rawMatch = path.join(CONFIG.INPUT_DIR, filename);
  if (fs.existsSync(rawMatch)) {
    return rawMatch;
  }

  const allArchived = getPDFsRecursively(CONFIG.OUTPUT_ROOT_DIR);
  const found = allArchived.find(f => path.basename(f).toLowerCase() === filename.toLowerCase());
  return found || null;
}

// Golden Rule #5: the category/subcategory must exist in categories.json BEFORE any
// physical file move — every caller that lets an explicit category/subcategory be set
// (not just the AI classification path) must run this first.
export function ensureCategoryAndSubcategoryExist(category: string, subcategory: string): void {
  const categoriesConfig = getCategoriesConfig();
  let catObj = categoriesConfig.categories.find(c => c.id === category);
  if (!catObj) {
    catObj = {
      id: category,
      name: category.charAt(0).toUpperCase() + category.slice(1),
      description: `Category auto-created for ${category}`,
      aliases: [category],
      subcategories: []
    };
    categoriesConfig.categories.push(catObj);
  }

  if (!catObj.subcategories) catObj.subcategories = [];
  if (!catObj.subcategories.some(s => s.id === subcategory)) {
    catObj.subcategories.push({
      id: subcategory,
      name: subcategory.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      aliases: [subcategory]
    });
  }
  saveCategoriesConfig(categoriesConfig.categories);
}

export async function reclassifyAndRelocalizeDocument(
  id: number,
  explicitCategory?: string,
  explicitSubcategory?: string,
  userFeedbackReason?: string
): Promise<{
  success: boolean;
  staleCleaned?: boolean;
  error?: string;
  message?: string;
  document?: any;
}> {
  const doc = await getDocumentById(id);
  if (!doc) {
    return { success: false, error: 'Document not found' };
  }

  if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
    return { success: false, error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` };
  }

  const actualPath = findActualFileOnDisk(doc);
  if (!actualPath || !fs.existsSync(actualPath)) {
    logger.info('RELOCALIZE', `Purging stale ghost database record ID ${id} (${doc.title}) - missing on disk`);
    const db = await getDb();
    await db.run('DELETE FROM documents WHERE id = ?', [id]);
    try {
      await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    } catch (e) {}
    await syncJSONRegistry();
    return {
      success: false,
      staleCleaned: true,
      error: `Physical file '${doc.original_filename || doc.title}' was missing on disk. Cleaned up stale record.`
    };
  }

  const { raw_text } = await extractPDFContent(actualPath);
  const textToAnalyze = (raw_text && raw_text.trim().length > 10) ? raw_text : (doc.raw_text || '');

  let newCategory = doc.category;
  let newSubcategory = doc.subcategory;
  let newTitle = doc.title;
  let newDate = doc.date;
  let newSummary = doc.summary;
  let newMarkdown = doc.markdown_content;

  if (explicitCategory && explicitSubcategory) {
    // User explicitly chose Category & Subcategory from Modal
    newCategory = explicitCategory.toLowerCase().trim();
    newSubcategory = explicitSubcategory.toLowerCase().trim();
    ensureCategoryAndSubcategoryExist(newCategory, newSubcategory);
  } else {
    // Re-run Qwen 3.5 AI with optional user feedback note
    logger.info('RELOCALIZE', `Re-analyzing document content with AI for ID ${id} (${doc.title})...`, { userFeedbackReason });
    const meta = await classifyPDFText(textToAnalyze, doc.original_filename || path.basename(actualPath), userFeedbackReason);

    newCategory = meta.categorie;
    newSubcategory = meta.subcategorie;
    newTitle = meta.titre || doc.title;
    newDate = meta.date || doc.date;
    newSummary = meta.summary || doc.summary;
    newMarkdown = meta.markdown_content || doc.markdown_content;
  }

  const { newPath, moved } = relocalizeFileIfNeeded(actualPath, newCategory, newSubcategory, newDate);

  await updateDocumentRecord(id, {
    title: newTitle,
    category: newCategory,
    subcategory: newSubcategory,
    date: newDate,
    summary: newSummary,
    markdown_content: newMarkdown,
    new_path: newPath,
    status: 'MOVED'
  });

  await syncJSONRegistry();
  const updatedDoc = await getDocumentById(id);

  return {
    success: true,
    message: moved
      ? `📍 Re-analyzed & relocated document to: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`
      : `📍 Document re-analyzed & confirmed in canonical location: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`,
    document: updatedDoc
  };
}
```

- [ ] **Step 2: Remove these 5 functions (+ `renameAtomicNoOverwrite`) from `src/services/triage.service.ts`, import them back**

Delete `renameAtomicNoOverwrite`, `relocalizeFileIfNeeded`, `moveBackToRaws`, `findActualFileOnDisk`, `ensureCategoryAndSubcategoryExist`, `reclassifyAndRelocalizeDocument` from `triage.service.ts`.

Add to the imports:
```ts
import { relocalizeFileIfNeeded, moveBackToRaws, findActualFileOnDisk, ensureCategoryAndSubcategoryExist, reclassifyAndRelocalizeDocument } from '../application/relocalize-document.js';
```

`triage.service.ts` no longer calls `getCategoriesConfig`/`saveCategoriesConfig`/`isForbiddenSubcategory`/`computeCanonicalPath` itself after this removal (those were only used inside the moved functions) — but double check against `repairRegistry` (still in `triage.service.ts`, moves in Task 21) which uses `isYearString` (still needed, stays) but not `isForbiddenSubcategory`/`computeCanonicalPath`. Remove `isForbiddenSubcategory` and `computeCanonicalPath` from the `domain/taxonomy.js` import line if nothing else in the file uses them — change:
```ts
import { isYearString, isForbiddenSubcategory, isPathInsideDir, computeCanonicalPath } from '../domain/taxonomy.js';
```
to:
```ts
import { isYearString, isPathInsideDir } from '../domain/taxonomy.js';
```
Also remove `getCategoriesConfig, saveCategoriesConfig` from the `infrastructure/categories-store.js` import line if `repairRegistry` doesn't call them directly (it doesn't) — change:
```ts
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
```
Delete this line entirely.

(Read through the rest of `triage.service.ts` — `repairRegistry`, `runTriageScan`, `clearRegistryAndMoveArchiveToRaws` — before deleting any import to confirm nothing else in the file still uses it; the specific removals above are based on this task's function set, but verify against the actual current file content rather than trusting this list blindly, since earlier tasks in this plan have already shown two independent import-tracking mistakes that only checking the real file catches.)

- [ ] **Step 3: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws, ensureCategoryAndSubcategoryExist } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan, repairRegistry, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
import { relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, ensureCategoryAndSubcategoryExist } from '../application/relocalize-document.js';
```

- [ ] **Step 4: Update `src/mcp/server.ts`'s import**

Change:
```ts
import { runTriageScan, relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist, ScanInProgressError } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan, ScanInProgressError } from '../services/triage.service.js';
import { relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist } from '../application/relocalize-document.js';
```

- [ ] **Step 5: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move relocalize/moveBackToRaws/findActualFileOnDisk/ensureCategoryAndSubcategoryExist/reclassifyAndRelocalizeDocument to src/application/relocalize-document.ts"
```

---

## Task 19: `src/application/scan-lock.ts`

**Files:**
- Create: `src/application/scan-lock.ts`
- Modify: `src/services/triage.service.ts` (remove `SCAN_LOCK_FILE`/`ScanInProgressError`/`acquireScanLock`, import them back — note `acquireScanLock` was private before and must now be exported, since Tasks 20-22 move its 3 callers into separate files)
- Modify: `src/mcp/server.ts` (import path for `ScanInProgressError`)

**Interfaces:**
- Consumes: `readActiveLockHolder`, `acquireProcessLock` from `src/infrastructure/pid-lock.js` (Task 16); `BASE_DIR` from `src/infrastructure/settings.js`.
- Produces: `ScanInProgressError` (class, extends `Error`, has `holderPid: number`), `acquireScanLock(): () => void` — **newly exported** (was private in `triage.service.ts`), unchanged behavior.

- [ ] **Step 1: Create `src/application/scan-lock.ts`**

```ts
import path from 'path';
import { BASE_DIR } from '../infrastructure/settings.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';

// Cross-process guard: the web server's own auto-watcher/manual-scan/repair/clear
// routes already serialize themselves via an in-memory flag, but that can't stop a
// SEPARATE process (e.g. the MCP server, `npm run scan`, or a stray second server
// instance) from concurrently running one of these against the same __raws/__archive
// files. This file-based lock makes that cross-process case fail fast instead of racing.
const SCAN_LOCK_FILE = path.join(BASE_DIR, '.scan.lock');

export class ScanInProgressError extends Error {
  constructor(public readonly holderPid: number) {
    super(`A scan/repair/clear operation is already in progress (held by process ${holderPid}). Try again shortly.`);
  }
}

export function acquireScanLock(): () => void {
  const holderPid = readActiveLockHolder(SCAN_LOCK_FILE);
  if (holderPid !== null) {
    throw new ScanInProgressError(holderPid);
  }
  return acquireProcessLock(SCAN_LOCK_FILE);
}
```

- [ ] **Step 2: Remove these from `src/services/triage.service.ts`, import them back**

Delete `SCAN_LOCK_FILE`, `ScanInProgressError`, `acquireScanLock` from `triage.service.ts` (the `readActiveLockHolder`/`acquireProcessLock` import from Task 16 becomes unused here too — remove it, since this file no longer touches the lock file directly).

Add to the imports:
```ts
import { ScanInProgressError, acquireScanLock } from '../application/scan-lock.js';
```

Verify against the actual current file content that no other function in `triage.service.ts` still calls `readActiveLockHolder`/`acquireProcessLock` directly before removing that import line — `repairRegistry`, `runTriageScan`, and `clearRegistryAndMoveArchiveToRaws` should each only call `acquireScanLock()` (the wrapper), not the pid-lock primitives directly.

- [ ] **Step 3: Update `src/mcp/server.ts`'s import**

Change:
```ts
import { runTriageScan, ScanInProgressError } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan } from '../services/triage.service.js';
import { ScanInProgressError } from '../application/scan-lock.js';
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move ScanInProgressError/acquireScanLock to src/application/scan-lock.ts, export acquireScanLock"
```

---

## Task 20: `src/application/triage-scan.ts`

**Files:**
- Create: `src/application/triage-scan.ts`
- Modify: `src/services/triage.service.ts` (remove `TriageResultItem`/`TriageProgressEvent`/`runTriageScan`, import back if still referenced — check whether anything else in the file uses these types)
- Modify: `src/server/web_server.ts`, `src/mcp/server.ts`, `src/index.ts` (import path for `runTriageScan`)

**Interfaces:**
- Consumes: `acquireScanLock` from `src/application/scan-lock.js` (Task 19); `CONFIG`, `ensureDirectoriesExist`, `reloadConfigFromDisk` from `src/infrastructure/settings.js`; `getPDFsRecursively` from `src/infrastructure/pdf-scanner.js`; `extractPDFContent` from `src/infrastructure/pdf-extractor.js`; `getDocumentByChecksum`, `insertDocumentRecord`, `updateDocumentRecord` from `src/infrastructure/db/database.js`; `classifyPDFText` from `src/application/classify-document.js` (Task 17); `generateEmbedding` from `src/infrastructure/ollama-client.js`; `relocalizeFileIfNeeded` from `src/application/relocalize-document.js` (Task 18); `syncJSONRegistry` from `src/infrastructure/json-registry.js`; `logger` from `src/infrastructure/logger.js`.
- Produces: `TriageResultItem` interface, `TriageProgressEvent` interface, `runTriageScan(onProgress?): Promise<{scannedCount, processedCount, skippedCount, items}>` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/application/triage-scan.ts`**

```ts
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord } from '../infrastructure/db/database.js';
import { classifyPDFText } from './classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { relocalizeFileIfNeeded } from './relocalize-document.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';

export interface TriageResultItem {
  filename: string;
  docId: number;
  title: string;
  category: string;
  subcategory: string;
  newPath: string;
  status: string;
}

export interface TriageProgressEvent {
  type: 'SCAN_STARTED' | 'FILE_PROGRESS' | 'FILE_COMPLETED' | 'FILE_FAILED' | 'SCAN_COMPLETED';
  totalFiles?: number;
  files?: string[];
  filename?: string;
  stage?: 'EXTRACTING_TEXT' | 'AI_CLASSIFYING' | 'RELOCALIZING' | 'COMPLETED' | 'SKIPPED_DUPLICATE' | 'FAILED';
  message?: string;
  docId?: number;
  title?: string;
  category?: string;
  subcategory?: string;
  newPath?: string;
  scannedCount?: number;
  processedCount?: number;
  skippedCount?: number;
}

export async function runTriageScan(onProgress?: (event: TriageProgressEvent) => void): Promise<{
  scannedCount: number;
  processedCount: number;
  skippedCount: number;
  items: TriageResultItem[];
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Scanning for PDFs in: ${CONFIG.INPUT_DIR}`);
  console.log(`Output Root Directory: ${CONFIG.OUTPUT_ROOT_DIR}`);

  const pdfFilePaths = getPDFsRecursively(CONFIG.INPUT_DIR, CONFIG.OUTPUT_ROOT_DIR);
  const filenames = pdfFilePaths.map(p => path.basename(p));

  onProgress?.({
    type: 'SCAN_STARTED',
    totalFiles: pdfFilePaths.length,
    files: filenames
  });
  
  let processedCount = 0;
  let skippedCount = 0;
  const items: TriageResultItem[] = [];

  for (const originalPath of pdfFilePaths) {
    const file = path.basename(originalPath);

    try {
      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'EXTRACTING_TEXT',
        message: 'Extracting text layer from PDF...'
      });

      const { checksum, raw_text } = await extractPDFContent(originalPath);

      const cleanText = (raw_text || '').trim();
      if (!cleanText || cleanText.length < 10) {
        logger.warn('TRIAGE', `BLOCKED: No text extracted from PDF '${file}'. Kept in __raws.`, { originalPath });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message: '❌ Blocked: No text extracted from PDF. Kept in __raws.'
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        logger.info('TRIAGE', `Skipping duplicate file '${file}' (Checksum in DB, ID: ${existing.id})`);
        skippedCount++;
        items.push({
          filename: file,
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: existing.new_path,
          status: 'SKIPPED_DUPLICATE'
        });

        onProgress?.({
          type: 'FILE_COMPLETED',
          filename: file,
          stage: 'SKIPPED_DUPLICATE',
          message: 'Duplicate file (Already in database)',
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: existing.new_path
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'AI_CLASSIFYING',
        message: 'Analyzing text, title, date & subcategory with Qwen 3.5 AI...'
      });

      console.log(`Classifying '${file}'...`);
      const metadata = await classifyPDFText(raw_text, file);

      const subcat = (metadata.subcategorie || '').toLowerCase().trim();
      if (!subcat || subcat === 'general' || subcat === 'other' || subcat === 'divers') {
        logger.warn('TRIAGE', `BLOCKED: No specific subcategory detected for '${file}' (subcat='${subcat}'). Kept in __raws.`, { originalPath });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message: `❌ Blocked: Failed to assign specific subcategory to '${file}'. Kept in __raws.`
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const embedding = await generateEmbedding(raw_text);

      const docId = await insertDocumentRecord({
        checksum,
        title: metadata.titre,
        registre: metadata.registre,
        date: metadata.date,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        summary: metadata.summary,
        tags: metadata.tags,
        raw_text,
        markdown_content: metadata.markdown_content || '',
        original_filename: file,
        original_path: originalPath,
        embedding,
        status: 'PENDING'
      });

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'RELOCALIZING',
        message: `Moving file to __archive/${metadata.categorie}/${metadata.subcategorie || 'general'}/...`
      });

      const { newPath: finalTargetPath } = relocalizeFileIfNeeded(
        originalPath,
        metadata.categorie,
        metadata.subcategorie,
        metadata.date
      );

      await updateDocumentRecord(docId, {
        new_path: finalTargetPath,
        status: 'MOVED'
      });

      processedCount++;
      items.push({
        filename: file,
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath,
        status: 'MOVED'
      });

      onProgress?.({
        type: 'FILE_COMPLETED',
        filename: file,
        stage: 'COMPLETED',
        message: 'Successfully triaged & relocated',
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath
      });

      logger.info('TRIAGE', `Successfully triaged '${file}' -> ID: ${docId}, Category: ${metadata.categorie}/${metadata.subcategorie}`);
    } catch (err: any) {
      logger.error('TRIAGE', `Error processing file ${file}: ${err.message}`);
      onProgress?.({
        type: 'FILE_FAILED',
        filename: file,
        stage: 'FAILED',
        message: err.message
      });
    } finally {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  await syncJSONRegistry();

  onProgress?.({
    type: 'SCAN_COMPLETED',
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount
  });

  return {
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount,
    items
  };
  } finally {
    release();
  }
}
```

- [ ] **Step 2: Remove `TriageResultItem`, `TriageProgressEvent`, `runTriageScan` from `src/services/triage.service.ts`, import `runTriageScan` back if still called internally**

Delete the three from `triage.service.ts`. Check the remaining file content (`repairRegistry`, `clearRegistryAndMoveArchiveToRaws`) — neither calls `runTriageScan` internally, so no re-import is needed inside `triage.service.ts` itself for this task; just remove the deleted code and any now-unused imports it was the sole user of (verify against the actual file — don't assume from this list alone).

- [ ] **Step 3: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { runTriageScan, repairRegistry, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
```
to:
```ts
import { repairRegistry, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
import { runTriageScan } from '../application/triage-scan.js';
```

- [ ] **Step 4: Update `src/mcp/server.ts`'s import**

Change:
```ts
import { runTriageScan } from '../services/triage.service.js';
```
to:
```ts
import { runTriageScan } from '../application/triage-scan.js';
```

- [ ] **Step 5: Update `src/index.ts`'s import**

Change:
```ts
import { runTriageScan } from './services/triage.service.js';
```
to:
```ts
import { runTriageScan } from './application/triage-scan.js';
```

- [ ] **Step 6: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move runTriageScan to src/application/triage-scan.ts"
```

---

## Task 21: `src/application/repair-registry.ts`

**Files:**
- Create: `src/application/repair-registry.ts`
- Modify: `src/services/triage.service.ts` (remove `repairRegistry`)
- Modify: `src/server/web_server.ts` (import path)

**Interfaces:**
- Consumes: `acquireScanLock` (Task 19); `CONFIG`, `ensureDirectoriesExist`, `reloadConfigFromDisk` (Task 8); `getAllDocuments`, `updateDocumentRecord`, `getDb`, `getDocumentByChecksum`, `insertDocumentRecord` (Task 9); `isYearString` (Task 3); `getAllFilesRecursively` (Task 15); `extractPDFContent` (Task 14); `moveBackToRaws`, `findActualFileOnDisk`, `relocalizeFileIfNeeded` (Task 18); `ruleBasedClassify` (Task 4); `getEntityDictionary` (Task 12); `classifyPDFText` (Task 17); `generateEmbedding` (Task 13); `syncJSONRegistry` (Task 10); `logger` (Task 7).
- Produces: `repairRegistry(): Promise<{scannedCount, repairedCount, updatedCount, relocalizedCount, movedToRawsCount}>` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/application/repair-registry.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getAllDocuments, updateDocumentRecord, getDb, getDocumentByChecksum, insertDocumentRecord } from '../infrastructure/db/database.js';
import { isYearString } from '../domain/taxonomy.js';
import { getAllFilesRecursively } from '../infrastructure/pdf-scanner.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { moveBackToRaws, findActualFileOnDisk, relocalizeFileIfNeeded } from './relocalize-document.js';
import { ruleBasedClassify } from '../domain/classification.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { classifyPDFText } from './classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';

export async function repairRegistry(): Promise<{
  scannedCount: number;
  repairedCount: number;
  updatedCount: number;
  relocalizedCount: number;
  movedToRawsCount: number;
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Starting Repair Registry & Relocalization on: ${CONFIG.OUTPUT_ROOT_DIR}`);
  
  const existingDocs = await getAllDocuments();
  let ghostPurgedCount = 0;
  for (const doc of existingDocs) {
    if (isYearString(doc.subcategory)) {
      await updateDocumentRecord(doc.id, { subcategory: 'general' });
    }
    const actual = findActualFileOnDisk(doc);
    if (!actual || !fs.existsSync(actual)) {
      logger.info('REPAIR', `Purging ghost database record ID ${doc.id} (${doc.title}) - missing on disk`);
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [doc.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [doc.id]);
      } catch (e) {}
      ghostPurgedCount++;
    }
  }

  const archivedFiles = getAllFilesRecursively(CONFIG.OUTPUT_ROOT_DIR);
  
  let repairedCount = 0;
  let updatedCount = 0;
  let relocalizedCount = 0;
  let movedToRawsCount = 0;

  for (const filePath of archivedFiles) {
    try {
      if (!fs.existsSync(filePath)) continue;

      const file = path.basename(filePath);
      const { checksum, raw_text } = await extractPDFContent(filePath);

      const isMissingContent = !raw_text || raw_text.trim().length === 0 || raw_text.includes('[No raw text extracted]');

      if (isMissingContent) {
        await moveBackToRaws(filePath, checksum);
        movedToRawsCount++;
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        const currentText = (existing.raw_text || '').trim();
        if (currentText.length < 15 || currentText.includes('[No raw text extracted]') || (raw_text.length > 20 && currentText !== raw_text)) {
          logger.info('REPAIR', `Updating raw text for doc ID ${existing.id} (${file}): ${raw_text.length} chars`);
          await updateDocumentRecord(existing.id, { raw_text });
          updatedCount++;
        }

        let currentCat = existing.category;
        let currentSub = existing.subcategory;
        const isGeneric = !currentSub || currentSub === 'general' || currentSub === 'other' || currentSub === 'divers' || currentCat === 'personal';

        if (isGeneric) {
          const rb = ruleBasedClassify(raw_text || currentText, file, getEntityDictionary(), CONFIG.PERSONAL_NAME_DENYLIST);
          if (rb.subcategorie !== 'general' && rb.subcategorie !== 'other' && rb.subcategorie !== 'divers') {
            currentCat = rb.categorie;
            currentSub = rb.subcategorie;
            logger.info('REPAIR', `Re-classified document ID ${existing.id} (${file}): ${existing.category}/${existing.subcategory} -> ${currentCat}/${currentSub}`);
            await updateDocumentRecord(existing.id, {
              category: currentCat,
              subcategory: currentSub
            });
            updatedCount++;
          } else {
            logger.warn('REPAIR', `Document ID ${existing.id} (${file}) has no specific subcategory. Moving back to __raws!`);
            await moveBackToRaws(filePath, checksum);
            movedToRawsCount++;
            continue;
          }
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, currentCat, currentSub, existing.date);
        
        if (moved) relocalizedCount++;

        if (existing.new_path !== newPath || existing.status !== 'MOVED') {
          await updateDocumentRecord(existing.id, {
            new_path: newPath,
            status: 'MOVED'
          });
          updatedCount++;
        }
      } else {
        const rel = path.relative(CONFIG.OUTPUT_ROOT_DIR, filePath);
        const parts = rel.split(path.sep);
        
        const pathCat = parts[0] || 'other';
        const pathSub = parts.length >= 3 ? parts[1] : 'general';

        console.log(`Repairing & analyzing unindexed file '${file}' (Path hint: ${pathCat}/${pathSub})...`);
        const metadata = await classifyPDFText(raw_text, file);
        const embedding = await generateEmbedding(raw_text);

        const targetCat = metadata.categorie;
        const targetSub = metadata.subcategorie;
        const targetDate = metadata.date || '';

        const isGenericTarget = !targetSub || targetSub === 'general' || targetSub === 'other' || targetSub === 'divers';
        if (isGenericTarget) {
          logger.warn('REPAIR', `Unindexed file '${file}' has no specific subcategory. Moving back to __raws!`);
          await moveBackToRaws(filePath, checksum);
          movedToRawsCount++;
          continue;
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, targetCat, targetSub, targetDate);
        if (moved) relocalizedCount++;

        try {
          await insertDocumentRecord({
            checksum,
            title: metadata.titre || file.replace(/\.pdf$/i, ''),
            registre: metadata.registre || '',
            date: targetDate,
            category: targetCat,
            subcategory: targetSub,
            summary: metadata.summary || '',
            tags: metadata.tags || [],
            raw_text,
            original_filename: file,
            original_path: filePath,
            new_path: newPath,
            embedding,
            status: 'MOVED'
          });
          repairedCount++;
        } catch (dbErr: any) {
          if (dbErr.message?.includes('UNIQUE constraint failed')) {
            const existingDoc = await getDocumentByChecksum(checksum);
            if (existingDoc) {
              await updateDocumentRecord(existingDoc.id, {
                category: targetCat,
                subcategory: targetSub,
                new_path: newPath,
                status: 'MOVED'
              });
              updatedCount++;
            }
          } else {
            console.warn(`Error inserting record for ${file}:`, dbErr.message);
          }
        }
      }
    } catch (err: any) {
      console.warn(`Error repairing file ${filePath}:`, err.message);
    }
  }

  await syncJSONRegistry();

  return {
    scannedCount: archivedFiles.length,
    repairedCount,
    updatedCount,
    relocalizedCount,
    movedToRawsCount
  };
  } finally {
    release();
  }
}
```

(`ghostPurgedCount` is computed but not included in the return value — a pre-existing quirk in the original code, preserved exactly, not this task's concern to fix.)

- [ ] **Step 2: Remove `repairRegistry` from `src/services/triage.service.ts`**

Delete the function. Verify against the actual remaining file content (just `clearRegistryAndMoveArchiveToRaws` should be left after this) whether any now-unused imports need removing — don't assume from this list alone.

- [ ] **Step 3: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { repairRegistry, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
```
to:
```ts
import { clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
import { repairRegistry } from '../application/repair-registry.js';
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move repairRegistry to src/application/repair-registry.ts"
```

---

## Task 22: `src/application/clear-registry.ts`

The last piece of `triage.service.ts` moves out — the file is empty afterward and is deleted, along with the now-empty `src/services/` directory.

**Files:**
- Create: `src/application/clear-registry.ts`
- Delete: `src/services/triage.service.ts`
- Modify: `src/server/web_server.ts` (import path)

**Interfaces:**
- Consumes: `acquireScanLock` (Task 19); `CONFIG`, `ensureDirectoriesExist`, `reloadConfigFromDisk` (Task 8); `getAllDocuments`, `getDb` (Task 9); `findActualFileOnDisk`, `moveBackToRaws` (Task 18); `isPathInsideDir` (Task 3); `syncJSONRegistry` (Task 10).
- Produces: `clearRegistryAndMoveArchiveToRaws(): Promise<{ countMoved: number }>` — unchanged behavior, new location.

- [ ] **Step 1: Create `src/application/clear-registry.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getAllDocuments, getDb } from '../infrastructure/db/database.js';
import { findActualFileOnDisk, moveBackToRaws } from './relocalize-document.js';
import { isPathInsideDir } from '../domain/taxonomy.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';

export async function clearRegistryAndMoveArchiveToRaws(): Promise<{ countMoved: number }> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  const existingDocs = await getAllDocuments();
  console.log(`Clearing registry (${existingDocs.length} records) and moving all physical files from __archive to __raws...`);

  let countMoved = 0;
  for (const doc of existingDocs) {
    const actualPath = findActualFileOnDisk(doc);
    if (actualPath && fs.existsSync(actualPath) && isPathInsideDir(actualPath, CONFIG.OUTPUT_ROOT_DIR)) {
      try {
        await moveBackToRaws(actualPath);
        countMoved++;
      } catch (err: any) {
        console.warn(`Error moving file ${actualPath} back to __raws:`, err.message);
      }
    }
  }

  const db = await getDb();
  await db.run('DELETE FROM documents');
  try {
    await db.run('DELETE FROM documents_fts');
  } catch (e) {}

  // Any files still left under __archive at this point have no matching DB row
  // (e.g. a repair/insert that never completed). Never delete a PDF — move these
  // orphans back to __raws too, same as tracked files, then remove the now-empty
  // folder skeleton so the next scan reconstructs it cleanly.
  try {
    const moveOrphansAndRemoveEmptyDirs = async (dirPath: string): Promise<void> => {
      if (!fs.existsSync(dirPath)) return;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          await moveOrphansAndRemoveEmptyDirs(curPath);
        } else {
          try {
            await moveBackToRaws(curPath);
            countMoved++;
          } catch (err: any) {
            console.warn(`Error moving orphaned file ${curPath} back to __raws:`, err.message);
          }
        }
      }
      if (
        dirPath.toLowerCase() !== path.normalize(CONFIG.OUTPUT_ROOT_DIR).toLowerCase() &&
        fs.existsSync(dirPath) &&
        fs.readdirSync(dirPath).length === 0
      ) {
        fs.rmdirSync(dirPath);
      }
    };
    await moveOrphansAndRemoveEmptyDirs(CONFIG.OUTPUT_ROOT_DIR);
    ensureDirectoriesExist();
  } catch (e) {}

  await syncJSONRegistry();

  console.log(`Clear Registry Completed: Purged DB & moved ${countMoved} physical files from __archive back to __raws.`);
  return { countMoved };
  } finally {
    release();
  }
}
```

Delete `src/services/triage.service.ts`. Verify `src/services/` is now empty and gone (it should have no files left — `ai.service.ts`, `pdf.service.ts`, `json_registry.service.ts`, `logger.service.ts` all moved out in earlier tasks).

- [ ] **Step 2: Update `src/server/web_server.ts`'s import**

Change:
```ts
import { clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
```
to:
```ts
import { clearRegistryAndMoveArchiveToRaws } from '../application/clear-registry.js';
```

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests. `src/services/` no longer exists.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move clearRegistryAndMoveArchiveToRaws to src/application/clear-registry.ts, delete triage.service.ts"
```

---

## Task 23: `src/infrastructure/http/web-server.ts`

`web_server.ts`'s route logic itself doesn't change in this task — only its file location and (as a direct consequence) every one of its import paths, since the file moves two directories deeper (`src/server/` → `src/infrastructure/http/`).

**Files:**
- Create: `src/infrastructure/http/web-server.ts` (relocated from `src/server/web_server.ts`)
- Delete: `src/server/web_server.ts`
- Modify: `src/index.ts` (import path only)

**Interfaces:**
- Produces: `createWebServer(): express.Express`, `startWebServer(port?: number): void` — unchanged behavior, new location.

**Correction (same class of issue found and fixed in Task 8):** `src/index.ts` imports `startWebServer` from `./server/web_server.js` — that path stops existing the moment this task's `git mv` runs, so `index.ts` must be fixed in this same task (Step 3 below), not deferred to Task 25.

- [ ] **Step 1: Move the file**

```bash
git mv src/server/web_server.ts src/infrastructure/http/web-server.ts
```

- [ ] **Step 2: Replace the entire top-of-file import block**

By this point in the plan, every import in `web_server.ts` has been incrementally updated across Tasks 2, 3, 7, 8, 9, 10, 11, 13, 15, 16, 18, 20, 21, 22 (verify this against the file's actual current content before editing — don't assume). The accumulated import block, BEFORE accounting for this task's own directory move, should read:

```ts
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { Ollama } from 'ollama';
import { z } from 'zod';
import { CONFIG, BASE_DIR, updateConfig } from '../infrastructure/settings.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../infrastructure/db/database.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../infrastructure/categories-store.js';
import { checkModelCanGenerate } from '../infrastructure/ollama-client.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, ensureCategoryAndSubcategoryExist } from '../application/relocalize-document.js';
import { runTriageScan } from '../application/triage-scan.js';
import { repairRegistry } from '../application/repair-registry.js';
import { clearRegistryAndMoveArchiveToRaws } from '../application/clear-registry.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { logger } from '../infrastructure/logger.js';
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../domain/document.schema.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';
```

Replace that entire block with this — the file now lives at `src/infrastructure/http/web-server.ts`, so every path one level under `src/infrastructure/` becomes a plain sibling import (`./` or `../`), and everything under `src/domain/`/`src/application/` needs one extra `../`:

```ts
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { Ollama } from 'ollama';
import { z } from 'zod';
import { CONFIG, BASE_DIR, updateConfig } from '../settings.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../db/database.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../categories-store.js';
import { checkModelCanGenerate } from '../ollama-client.js';
import { syncJSONRegistry } from '../json-registry.js';
import { relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, ensureCategoryAndSubcategoryExist } from '../../application/relocalize-document.js';
import { runTriageScan } from '../../application/triage-scan.js';
import { repairRegistry } from '../../application/repair-registry.js';
import { clearRegistryAndMoveArchiveToRaws } from '../../application/clear-registry.js';
import { getPDFsRecursively } from '../pdf-scanner.js';
import { isForbiddenSubcategory } from '../../domain/taxonomy.js';
import { logger } from '../logger.js';
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../../domain/document.schema.js';
import { readActiveLockHolder, acquireProcessLock } from '../pid-lock.js';
```

Nothing else in the file changes — every route handler, the SSE broadcast logic, the auto-watcher `setInterval`, and `acquireSingleInstanceLock`/`startWebServer` all stay exactly as they are, since none of them reference a relative import path directly (they use the imported bindings, whose paths are fixed above).

- [ ] **Step 3: Update `src/index.ts`'s import**

Change:
```ts
import { startWebServer } from './server/web_server.js';
```
to:
```ts
import { startWebServer } from './infrastructure/http/web-server.js';
```

- [ ] **Step 4: Remove the now-empty `src/server/` directory**

Verify with `ls src/server` that it's gone after the `git mv`.

- [ ] **Step 5: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move web_server.ts to src/infrastructure/http/web-server.ts, update index.ts"
```

---

## Task 24: `src/infrastructure/mcp/mcp-server.ts`

Same pattern as Task 23 — `mcp/server.ts`'s tool-handler logic doesn't change, only its location and import paths.

**Files:**
- Create: `src/infrastructure/mcp/mcp-server.ts` (relocated from `src/mcp/server.ts`)
- Delete: `src/mcp/server.ts`
- Modify: `src/index.ts` (import path only)

**Interfaces:**
- Produces: `startMCPServer(): Promise<void>` — unchanged behavior, new location.

**Correction (same class of issue found and fixed in Task 8):** `src/index.ts` imports `startMCPServer` from `./mcp/server.js` — that path stops existing the moment this task's `git mv` runs, so `index.ts` must be fixed in this same task (Step 3 below), not deferred to Task 25.

- [ ] **Step 1: Move the file**

```bash
git mv src/mcp/server.ts src/infrastructure/mcp/mcp-server.ts
```

- [ ] **Step 2: Replace the entire top-of-file import block**

By this point, `mcp/server.ts`'s imports have been incrementally updated across Tasks 2, 3, 9, 10, 11, 18, 19, 20 (verify against the file's actual current content before editing). The accumulated import block, BEFORE accounting for this task's own directory move, should read:

```ts
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
import { getCategoriesConfig } from '../infrastructure/categories-store.js';
import { runTriageScan } from '../application/triage-scan.js';
import { relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist } from '../application/relocalize-document.js';
import { ScanInProgressError } from '../application/scan-lock.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { UpdateDocumentSchema } from '../domain/document.schema.js';
```

Replace that entire block with this — the file now lives at `src/infrastructure/mcp/mcp-server.ts`:

```ts
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../db/database.js';
import { getCategoriesConfig } from '../categories-store.js';
import { runTriageScan } from '../../application/triage-scan.js';
import { relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist } from '../../application/relocalize-document.js';
import { ScanInProgressError } from '../../application/scan-lock.js';
import { isForbiddenSubcategory } from '../../domain/taxonomy.js';
import { syncJSONRegistry } from '../json-registry.js';
import { UpdateDocumentSchema } from '../../domain/document.schema.js';
```

Nothing else in the file changes.

- [ ] **Step 3: Update `src/index.ts`'s import**

Change:
```ts
import { startMCPServer } from './mcp/server.js';
```
to:
```ts
import { startMCPServer } from './infrastructure/mcp/mcp-server.js';
```

- [ ] **Step 4: Remove the now-empty `src/mcp/` directory**

Verify with `ls src/mcp` that it's gone after the `git mv`.

- [ ] **Step 5: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move mcp/server.ts to src/infrastructure/mcp/mcp-server.ts, update index.ts"
```

---

## Task 25: `src/index.ts` — final wiring verification

**Correction (found during Task 8's execution):** this task originally updated all 4 of `index.ts`'s imports here, at the end. That was wrong — deferring them left `npm run build` broken from Task 8 onward (the moment each dependency actually moved, `index.ts`'s stale import broke compilation). Each of the 4 imports has since been fixed in the same task that moved its target: `CONFIG`/`ensureDirectoriesExist` in Task 8, `runTriageScan` in Task 20, `startWebServer` in Task 23, `startMCPServer` in Task 24. This task is now verification-only — there should be nothing left to change.

**Files:** None modified.

**Interfaces:** None.

- [ ] **Step 1: Confirm `src/index.ts` needs no further changes**

Read the current `src/index.ts`. Its import block should already read:

```ts
import { ensureDirectoriesExist, CONFIG } from './infrastructure/settings.js';
import { startWebServer } from './infrastructure/http/web-server.js';
import { startMCPServer } from './infrastructure/mcp/mcp-server.js';
import { runTriageScan } from './application/triage-scan.js';
```

If it does NOT — i.e. if one of Tasks 8/20/23/24 didn't actually apply its `index.ts` fix — fix the discrepancy now (this is the last safe point to catch it before the boot smoke-check in Task 26), and report DONE_WITH_CONCERNS explaining which task's fix was missing.

- [ ] **Step 2: Verify**

Run: `npm run build && npm test`

Expected: both clean, same 86 tests. At this point every file under `src/` has been moved to its new home — confirm with `find src -type f -name "*.ts"` (or equivalent) that only `src/index.ts`, `src/domain/**`, `src/application/**`, and `src/infrastructure/**` remain (plus their `*.test.ts` siblings) — no `src/services/`, `src/schemas/`, `src/db/`, `src/server/`, `src/mcp/`, or `src/config.ts` left.

No commit for this task if Step 1 found nothing to change — it's verification-only. If Step 1 did find and fix a discrepancy, commit that fix with a message describing what was missing.

---

## Task 26: Boot smoke-check

A clean `tsc` proves the types line up, but not that the runtime import graph actually resolves and the app starts — this task verifies that directly, since this plan touched every file's import path.

**Files:** None modified — verification only.

**Interfaces:** None.

- [ ] **Step 1: Run a one-shot scan against the real configured `__raws` folder**

Run: `npx tsx src/index.ts scan`

Expected: the process starts, logs `Starting standalone PDF triage scan...`, performs a real scan (using whatever `settings.json` currently points `input_dir`/`output_root_dir` at), prints a `Triage finished: {...}` JSON summary, and exits with code 0. No `Cannot find module` / `ERR_MODULE_NOT_FOUND` errors — those would indicate a missed import-path update somewhere in Tasks 1-25.

This is a real scan against the real configured folders (same as `npm run scan` would do) — if `__raws` currently has files in it, they'll be processed exactly as `npm run scan` would process them. This is expected and matches this command's normal behavior; it is not a special test-only path.

- [ ] **Step 2: Run a timed start of the default web-server mode**

Run (adjust for your shell — the goal is: start the process, wait a few seconds, confirm it's still running and printed its startup banner, then stop it):

```bash
timeout 5 npx tsx src/index.ts || true
```

Expected: within the 5-second window, the process prints `Starting Web Dashboard & Triage API Server...` followed by `Web Dashboard is running at http://localhost:<port> [Hot Reload Active 🔥]` — confirming `startWebServer` actually boots (Express listens, no import error, no immediate crash). The process is killed by `timeout` after 5s (expected, not a failure) — `|| true` prevents the timeout's non-zero exit from failing this step.

If port 3000 (or whatever `CONFIG.PORT` resolves to) is already in use by a `npm run dev` instance you have running, this step will instead print the `EADDRINUSE` error and exit — if you see that, it confirms the import graph resolved correctly (the code reached the point of trying to bind the port), just report `DONE_WITH_CONCERNS` noting the port conflict rather than treating it as a restructuring failure.

- [ ] **Step 3: Report results**

No commit for this task — it's verification-only. Include the actual console output from both steps in your task report.

---

## Task 27: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update the agent-ownership table**

Change:
```markdown
| Agent | Owns |
| --- | --- |
| [pipeline-engineer](docs/agents/pipeline-engineer.md) | triage.service, pdf.service, web_server, SSE, auto-watcher |
| [classification-expert](docs/agents/classification-expert.md) | ai.service, Qwen prompt, ruleBasedClassify, categories.json |
| [db-registry-keeper](docs/agents/db-registry-keeper.md) | database.ts, schemas, FTS5, JSON registry mirror |
| [ui-frontend](docs/agents/ui-frontend.md) | public/ (HTML/CSS/JS), modals, pills, Toast, SSE consumer |
| [mcp-integrator](docs/agents/mcp-integrator.md) | mcp/server.ts, tool schemas |
| [ollama-ops](docs/agents/ollama-ops.md) | Ollama connectivity, /api/ollama/*, model lifecycle |
| [qa-reviewer](docs/agents/qa-reviewer.md) | Rules audit — no code, just verdicts |
| [docs-curator](docs/agents/docs-curator.md) | docs/ + CLAUDE.md + .claude/agents/*.md shells |
```
to:
```markdown
| Agent | Owns |
| --- | --- |
| [pipeline-engineer](docs/agents/pipeline-engineer.md) | src/application/{triage-scan,repair-registry,relocalize-document,clear-registry,scan-lock}.ts, src/infrastructure/http/web-server.ts, src/infrastructure/{pdf-extractor,pdf-scanner,pid-lock}.ts, SSE, auto-watcher |
| [classification-expert](docs/agents/classification-expert.md) | src/domain/{classification,prompt,classification-resolution}.ts, src/application/classify-document.ts, src/infrastructure/entity-dictionary-store.ts, categories.json, entity_dictionary.json |
| [db-registry-keeper](docs/agents/db-registry-keeper.md) | src/infrastructure/db/database.ts, src/domain/document.schema.ts, src/infrastructure/{categories-store,json-registry}.ts, FTS5 |
| [ui-frontend](docs/agents/ui-frontend.md) | public/ (HTML/CSS/JS), modals, pills, Toast, SSE consumer |
| [mcp-integrator](docs/agents/mcp-integrator.md) | src/infrastructure/mcp/mcp-server.ts, tool schemas |
| [ollama-ops](docs/agents/ollama-ops.md) | src/infrastructure/ollama-client.ts, Ollama connectivity, /api/ollama/*, model lifecycle |
| [qa-reviewer](docs/agents/qa-reviewer.md) | Rules audit — no code, just verdicts |
| [docs-curator](docs/agents/docs-curator.md) | docs/ + CLAUDE.md + .claude/agents/*.md shells |
```

- [ ] **Step 2: Update the repo-layout tree**

Change:
```
├── src/
│   ├── index.ts               # dispatch: default web, `scan`, `mcp`
│   ├── config.ts
│   ├── db/database.ts
│   ├── schemas/document.schema.ts
│   ├── services/{pdf,ai,triage,json_registry,logger}.service.ts
│   ├── server/web_server.ts
│   └── mcp/server.ts
```
to:
```
├── src/
│   ├── index.ts                       # composition root: dispatch default web, `scan`, `mcp`
│   ├── domain/                        # pure logic, zero I/O
│   │   ├── document.schema.ts         # Zod schemas
│   │   ├── classification.ts          # ruleBasedClassify, cleanAndParseJSON, entity matching
│   │   ├── prompt.ts                  # Qwen prompt building
│   │   ├── classification-resolution.ts  # refine/resolve category & subcategory
│   │   ├── taxonomy.ts                # isForbiddenSubcategory, computeCanonicalPath
│   │   └── pdf-text.ts                # cleanExtractedText
│   ├── application/                   # orchestration / use-cases
│   │   ├── classify-document.ts       # classifyPDFText orchestrator
│   │   ├── triage-scan.ts             # runTriageScan
│   │   ├── repair-registry.ts
│   │   ├── relocalize-document.ts
│   │   ├── clear-registry.ts
│   │   └── scan-lock.ts
│   └── infrastructure/                # I/O adapters
│       ├── settings.ts                # CONFIG, settings.json
│       ├── logger.ts
│       ├── categories-store.ts        # categories.json read/write
│       ├── entity-dictionary-store.ts # entity_dictionary.json read
│       ├── ollama-client.ts
│       ├── pdf-extractor.ts
│       ├── pdf-scanner.ts
│       ├── pid-lock.ts
│       ├── db/database.ts
│       ├── json-registry.ts
│       ├── http/web-server.ts
│       └── mcp/mcp-server.ts
```

- [ ] **Step 3: Verify**

Run: `npm run build && npm test`

Expected: both clean (this task doesn't touch code, so this just confirms nothing regressed). Read the updated `CLAUDE.md` back and confirm every file path mentioned actually exists (`ls` each one, or a quick loop) — a stale doc path is worse than no doc.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md agent-ownership table and repo-layout tree for DDD restructure"
```

---

## Task 28: Update `docs/agents/*.md` playbooks

**Files:**
- Modify: `docs/agents/pipeline-engineer.md`, `docs/agents/classification-expert.md`, `docs/agents/db-registry-keeper.md`, `docs/agents/mcp-integrator.md`, `docs/agents/ollama-ops.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update file-path references in each playbook**

Read each of the 5 files listed above. Each one references old file paths (e.g. `src/services/ai.service.ts`, `src/services/triage.service.ts`, `src/db/database.ts`, `src/server/web_server.ts`, `src/mcp/server.ts`, `src/config.ts`, `src/schemas/document.schema.ts`) in its prose and/or code snippets. For each old path found, replace it with its new home per the mapping below — this is a search-and-replace pass, not a rewrite of the playbooks' actual guidance content (the advice/rules in each playbook stay the same; only the paths they point at change):

| Old path | New path |
|---|---|
| `src/services/ai.service.ts` (classification/parsing functions) | `src/domain/classification.ts`, `src/domain/prompt.ts`, `src/domain/classification-resolution.ts` |
| `src/services/ai.service.ts` (`classifyPDFText`) | `src/application/classify-document.ts` |
| `src/services/triage.service.ts` (`runTriageScan`) | `src/application/triage-scan.ts` |
| `src/services/triage.service.ts` (`repairRegistry`) | `src/application/repair-registry.ts` |
| `src/services/triage.service.ts` (relocalize/moveBackToRaws/etc.) | `src/application/relocalize-document.ts` |
| `src/services/triage.service.ts` (`clearRegistryAndMoveArchiveToRaws`) | `src/application/clear-registry.ts` |
| `src/services/triage.service.ts` (taxonomy helpers) | `src/domain/taxonomy.ts` |
| `src/services/pdf.service.ts` | `src/infrastructure/pdf-extractor.ts` (+ `src/domain/pdf-text.ts` for `cleanExtractedText`) |
| `src/services/json_registry.service.ts` | `src/infrastructure/json-registry.ts` |
| `src/services/logger.service.ts` | `src/infrastructure/logger.ts` |
| `src/db/database.ts` | `src/infrastructure/db/database.ts` |
| `src/config.ts` | `src/infrastructure/settings.ts` |
| `src/schemas/document.schema.ts` | `src/domain/document.schema.ts` |
| `src/server/web_server.ts` | `src/infrastructure/http/web-server.ts` |
| `src/mcp/server.ts` | `src/infrastructure/mcp/mcp-server.ts` |
| `getCategoriesConfig`/`saveCategoriesConfig` (were in ai.service.ts) | `src/infrastructure/categories-store.ts` |
| `getEntityDictionary` (was in ai.service.ts) | `src/infrastructure/entity-dictionary-store.ts` |
| `ensureOllamaModel`/`checkModelCanGenerate`/`generateEmbedding` (were in ai.service.ts) | `src/infrastructure/ollama-client.ts` |

Read each playbook file fully before editing — some references may be in code blocks showing example snippets (update the import paths shown in those snippets too, not just prose mentions).

- [ ] **Step 2: Verify**

Grep each of the 5 files afterward for any remaining occurrence of the old paths (`src/services/`, `src/db/database.ts` without `infrastructure/`, `src/schemas/`, `src/server/web_server.ts`, `src/mcp/server.ts`, bare `src/config.ts`) to confirm none were missed.

- [ ] **Step 3: Commit**

```bash
git add docs/agents/
git commit -m "docs: update docs/agents/*.md file-path references for DDD restructure"
```

---

## Task 29: Add architecture section to `docs/knowledge/architecture.md`

**Files:**
- Modify: `docs/knowledge/architecture.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Read the current file**

Read `docs/knowledge/architecture.md` in full to find the right insertion point and match its existing heading style/voice.

- [ ] **Step 2: Add a new section describing the three layers**

Insert a new section (heading level matching the file's existing convention) with this content:

```markdown
## Layering (domain / application / infrastructure)

`src/` is organized into three layers, each with a one-way dependency rule:

- **`src/domain/`** — pure logic, zero I/O. No `fs`, no network calls, no reading
  `CONFIG` or environment variables. Functions take data as parameters and return
  data. Includes classification rules (`classification.ts`), Qwen prompt building
  (`prompt.ts`), category/subcategory resolution (`classification-resolution.ts`),
  taxonomy/path helpers (`taxonomy.ts`), text cleanup (`pdf-text.ts`), and the Zod
  schemas (`document.schema.ts`).
- **`src/application/`** — orchestration ("use cases"). Fetches data via
  infrastructure, calls domain functions to decide what to do, calls infrastructure
  again to persist or act. This is where `classifyPDFText`, `runTriageScan`,
  `repairRegistry`, the relocalize/clear-registry flows, and the cross-process
  scan lock live.
- **`src/infrastructure/`** — all I/O adapters: SQLite (`db/database.ts`), the
  filesystem-backed settings/categories/entity-dictionary/JSON-registry stores,
  the Ollama client, the PDF extractor/scanner, the shared PID-lock helper, the
  Express HTTP server (`http/web-server.ts`), and the MCP stdio server
  (`mcp/mcp-server.ts`).

Dependency direction: `infrastructure/` and `application/` may import from
`domain/`; `domain/` never imports from the other two. `application/` may import
from `infrastructure/`; `infrastructure/` never imports from `application/`.
`src/index.ts` is the composition root — the only place that wires a concrete
infrastructure adapter (e.g. `startWebServer`) to the application layer.

This structure exists so the pure decision logic (which category, which
subcategory, is this slug grounded, what canonical path) can be unit-tested
without mocking `fs`/`CONFIG`/Ollama — see
`docs/superpowers/specs/2026-07-31-test-harness-design.md` (Phase 1) and
`docs/superpowers/specs/2026-07-31-ddd-restructure-design.md` (Phase 2, this
restructuring).
```

- [ ] **Step 3: Verify**

Read the file back to confirm the new section reads coherently in context and doesn't duplicate/contradict an existing section.

- [ ] **Step 4: Commit**

```bash
git add docs/knowledge/architecture.md
git commit -m "docs: document the domain/application/infrastructure layering in architecture.md"
```
