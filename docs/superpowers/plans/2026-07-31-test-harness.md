# Test Harness for Pure Classification/Path Logic Implementation Plan

> ⚠️ **Historical record.** Personal entity names in this document (employers, schools, banks, practitioners) have been replaced with fictional placeholders. Real values live in the gitignored `.prompts.private.json` overlay — see [taxonomy](../../knowledge/taxonomy.md#personal-prompt-overlay).


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Vitest unit test suite covering the pure/near-pure logic in `ai.service.ts`, `config.ts`, `document.schema.ts`, and `triage.service.ts`'s taxonomy/path helpers — including a regression test locking in today's `think:false` fix — so a later DDD restructuring has a safety net.

**Architecture:** Vitest with zero custom transform config (native ESM/TS support matches this project's `"type": "module"` + `tsx` setup). Tests colocated as `*.test.ts` next to the source file they cover. `fs` and `ollama` are mocked at the module boundary with `vi.mock`; everything else runs as real code — no test doubles for the classification/path/schema logic itself.

**Tech Stack:** TypeScript, Vitest, Zod (already a dependency). No new runtime dependencies — `vitest` is devDependency-only.

## Global Constraints

- Vitest only, not Jest — required for zero-config ESM/TS support in this `"type": "module"` project.
- Tests colocated as `src/**/*.test.ts` next to their source file.
- No coverage threshold enforced in this phase.
- No files move and no DDD/layering restructuring happens in this phase — that is a separate, later plan.
- No integration tests (real SQLite/filesystem/Ollama), no UI tests, no CI wiring in this phase.
- Bug fixes are bounded to what characterization testing genuinely surfaces while covering the module table in the spec — not an open-ended audit. Each fix ships with the regression test that caught it, and is called out in its commit message.
- `npm run build` (`tsc --noEmit`) must still pass after every task.
- Reference spec: `docs/superpowers/specs/2026-07-31-test-harness-design.md`.

---

## Task 1: Vitest setup

**Files:**
- Create: `vitest.config.ts` (project root)
- Modify: `package.json` (add devDependency + scripts)

**Interfaces:**
- Produces: `npm test` (single run), `npm run test:watch` (watch mode) — both invoked by every later task's verification step.

- [ ] **Step 1: Install Vitest**

Run: `npm install --save-dev vitest`

Expected: `package.json`'s `devDependencies` gains a `"vitest"` entry (whatever version npm resolves — do not hand-edit the version).

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block (after `"build": "tsc"`), add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Verify Vitest runs with zero tests**

Run: `npm test`

Expected: Vitest starts, reports "No test files found" (or exits 0 with zero suites) — confirms the config/ESM/TS wiring works before any real test is added.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add Vitest test harness (npm test / npm run test:watch)"
```

---

## Task 2: `ai.service.ts` — `cleanAndParseJSON` / `repairTruncatedJSON`

**Files:**
- Create: `src/services/ai.service.test.ts`
- Test target: `src/services/ai.service.ts:247-305` (`repairTruncatedJSON`, `cleanAndParseJSON`)

**Interfaces:**
- Consumes: `cleanAndParseJSON(rawStr: string): any` (exported, throws `Error('No JSON object found in AI response')` when no `{` is present; throws whatever `JSON.parse` throws if repair also fails).
- `repairTruncatedJSON` is not exported — tested only indirectly through `cleanAndParseJSON`'s malformed-JSON repair path.

- [ ] **Step 1: Create the test file with `cleanAndParseJSON` cases**

```ts
import { describe, it, expect } from 'vitest';
import { cleanAndParseJSON } from './ai.service.js';

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
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- ai.service`

Expected: all 5 tests pass. If any fails, compare the actual output vs. expected in the failure message — these expectations were verified against the running code before being written into this plan, so a failure here means either an environment difference or a real behavior change; do not edit the test to match an unexplained failure without understanding why first.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai.service.test.ts
git commit -m "test: cover cleanAndParseJSON / repairTruncatedJSON"
```

---

## Task 3: `ai.service.ts` — `matchEntityDictionary` / `buildEntityHintLine`

**Files:**
- Modify: `src/services/ai.service.test.ts`
- Test target: `src/services/ai.service.ts:60-97` (`getEntityDictionary`, `buildEntityHintLine`, `matchEntityDictionary`)

**Interfaces:**
- Consumes: `matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[]): { categorie: string; subcategorie: string } | null`, `buildEntityHintLine(categoryId: string): string`. Both call `getEntityDictionary()` internally, which reads `CONFIG.ENTITY_DICTIONARY_FILE` via `fs.existsSync`/`fs.readFileSync`.
- `EntityDictionary` shape (from `src/schemas/document.schema.ts`): `{ banks: EntityItem[]; energy: EntityItem[]; telecom: EntityItem[]; insurance: EntityItem[]; gov: EntityItem[]; health: EntityItem[] }`, `EntityItem = { slug: string; name: string; aliases: string[] }`.

- [ ] **Step 1: Add `vi.mock('fs')` and a fixture helper at the top of the test file**

Replace the file's two existing import lines (`import { describe, it, expect } from 'vitest';` and `import { cleanAndParseJSON } from './ai.service.js';`) with the following block — this is the complete, final top-of-file section for this step (later tasks will extend the `ai.service.js` import further, shown explicitly in each of those tasks):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine } from './ai.service.js';

vi.mock('fs');

afterEach(() => {
  vi.clearAllMocks();
});

function mockEntityDictionary(contents: object) {
  vi.mocked(fs.existsSync).mockImplementation((p) =>
    String(p).endsWith('entity_dictionary.json')
  );
  vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(contents) as any);
}
```

- [ ] **Step 2: Add `matchEntityDictionary` and `buildEntityHintLine` tests**

```ts
describe('matchEntityDictionary', () => {
  it('matches an entity by its exact name, case-insensitively', () => {
    mockEntityDictionary({
      banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: ['ca'] }],
    });
    const result = matchEntityDictionary('extrait de compte crédit agricole paris', ['banks']);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'credit_agricole' });
  });

  it('matches an entity by alias', () => {
    mockEntityDictionary({
      insurance: [{ slug: 'maif', name: 'MAIF', aliases: ['mutuelle assurance instituteurs'] }],
    });
    const result = matchEntityDictionary('contrat mutuelle assurance instituteurs 2024', ['insurance']);
    expect(result).toEqual({ categorie: 'insurance', subcategorie: 'maif' });
  });

  it('matches accented entity names against accented text (Unicode word boundary)', () => {
    mockEntityDictionary({
      banks: [{ slug: 'societe_generale', name: 'Société Générale', aliases: [] }],
    });
    const result = matchEntityDictionary('extrait de compte société générale paris', ['banks']);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'societe_generale' });
  });

  it('does not match a name as a substring of a longer word (word-boundary correctness)', () => {
    mockEntityDictionary({
      insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }],
    });
    // "taxaphone" contains "axa" as a substring but is not a match
    const result = matchEntityDictionary('société taxaphone service client', ['insurance']);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    mockEntityDictionary({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(matchEntityDictionary('nothing recognizable here', ['banks'])).toBeNull();
  });
});

describe('buildEntityHintLine', () => {
  it('formats matching entities as "slug (Name), slug (Name)."', () => {
    mockEntityDictionary({
      banks: [
        { slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] },
        { slug: 'fortuneo', name: 'Fortuneo', aliases: [] },
      ],
    });
    expect(buildEntityHintLine('administrative')).toBe(
      ' Known real-world entities: credit_agricole (Crédit Agricole), fortuneo (Fortuneo).'
    );
  });

  it('returns an empty string when no domain maps to the category', () => {
    mockEntityDictionary({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(buildEntityHintLine('totally_made_up_category_xyz')).toBe('');
  });
});
```

- [ ] **Step 3: Run and verify**

Run: `npm test -- ai.service`

Expected: all tests pass (5 from Task 2 + 7 new). If a test fails, re-check against the design: `matchEntityDictionary`'s word-boundary and accent-handling behavior was directly verified against the running regex before this plan was written (see "boundary false positive"/"accented full match" checks) — a failure here likely means a real regression, not a wrong expectation.

- [ ] **Step 4: Commit**

```bash
git add src/services/ai.service.test.ts
git commit -m "test: cover matchEntityDictionary / buildEntityHintLine, incl. Unicode word-boundary regression"
```

---

## Task 4: `ai.service.ts` — `isGroundedSubcategorySlug`

**Files:**
- Modify: `src/services/ai.service.test.ts`
- Test target: `src/services/ai.service.ts:181-245`

**Interfaces:**
- Consumes: `isGroundedSubcategorySlug(slug: string, rawText: string, filename: string): boolean`. Reads `CONFIG.PERSONAL_NAME_DENYLIST` internally (via `../config.js`) — with `fs` mocked and `existsSync` not configured to recognize `settings.json`, `CONFIG` uses its built-in default `['dupond', 'martin', 'lefebvre', 'bernard']` for the whole test file (config is loaded once, at this test file's first static import of `ai.service.ts`).

- [ ] **Step 1: Add the test block**

```ts
describe('isGroundedSubcategorySlug', () => {
  it('rejects a slug shorter than 3 characters', () => {
    expect(isGroundedSubcategorySlug('ab', 'ab ab ab', 'file.pdf')).toBe(false);
  });

  it('rejects a generic/structural word even if it appears in the text', () => {
    expect(isGroundedSubcategorySlug('page', 'page 1 of page 2', 'file.pdf')).toBe(false);
  });

  it('rejects a slug built from a personal/household name token', () => {
    // 'dupont' is in CONFIG's default PERSONAL_NAME_DENYLIST
    expect(isGroundedSubcategorySlug('jean_dupond', 'jean dupond jean dupond', 'file.pdf')).toBe(false);
  });

  it('rejects a slug with zero occurrences in the document text', () => {
    expect(isGroundedSubcategorySlug('veolia', 'nothing here', 'random.pdf')).toBe(false);
  });

  it('rejects a filename-echoed slug that appears only once in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia mentioned once', 'veolia_invoice.pdf')
    ).toBe(false);
  });

  it('accepts a filename-echoed slug that appears at least twice in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf')
    ).toBe(true);
  });

  it('accepts a non-filename-echoed slug that appears once in the text', () => {
    expect(
      isGroundedSubcategorySlug('france_travail', 'Contact France Travail for details', 'doc123.pdf')
    ).toBe(true);
  });
});
```

Update the `ai.service.js` import line (from Task 3) to the following complete line:

```ts
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug } from './ai.service.js';
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- ai.service`

Expected: all tests pass (12 from Tasks 2-3 + 7 new = 19). Every expected value above was directly verified against the running function before being written here.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai.service.test.ts
git commit -m "test: cover isGroundedSubcategorySlug guard (generic words, personal names, echo+occurrence rules)"
```

---

## Task 5: `ai.service.ts` — `ruleBasedClassify`

**Files:**
- Modify: `src/services/ai.service.test.ts`
- Test target: `src/services/ai.service.ts:307-534`

**Interfaces:**
- Consumes: `ruleBasedClassify(rawText: string, filename: string): { categorie: string; subcategorie: string; title: string; date: string }`.

- [ ] **Step 1: Add the test block**

```ts
describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const result = ruleBasedClassify(
      'Bulletin de salaire AcmeCorp Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf'
    );
    expect(result).toEqual({
      categorie: 'bulletin_salaire',
      subcategorie: 'acme_corp',
      title: 'bulletin mars',
      date: '2023-03-01',
    });
  });

  it('classifies a passport under identity/passeport', () => {
    const result = ruleBasedClassify('Republique Francaise Passeport N 12AB34567', 'doc.pdf');
    expect(result.categorie).toBe('identity');
    expect(result.subcategorie).toBe('passeport');
  });

  it('classifies a plain tax notice under administrative/impot', () => {
    const result = ruleBasedClassify(
      "Direction Generale des Finances Publiques DGFIP Avis d'impot sur le revenu 2023",
      'impot2023.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('impot');
  });

  it('does NOT misfile a bank statement as impot just because a transaction row mentions impots (Golden Rule #6 guard)', () => {
    const result = ruleBasedClassify(
      'RELEVE DE COMPTE Credit Mutuel Springfield PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
      'releve.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('classifies a vendor invoice via the hardcoded regex branch, with compact YYYYMMDD date', () => {
    const result = ruleBasedClassify('Facture SFR n 123456 Total TTC 45.99 EUR 20240512', 'facture.pdf');
    expect(result).toEqual({
      categorie: 'invoices',
      subcategorie: 'sfr',
      title: 'facture',
      date: '2024-05-12',
    });
  });

  it('classifies a vendor invoice via the entity-dictionary fallback when no hardcoded regex matches', () => {
    mockEntityDictionary({ energy: [{ slug: 'ekwateur', name: 'Ekwateur', aliases: [] }] });
    const result = ruleBasedClassify('Facture Ekwateur Total TTC 45 EUR', 'facture2.pdf');
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('ekwateur');
  });

  it('leaves subcategorie as "general" when no signal matches and the filename word is not grounded in the text', () => {
    const result = ruleBasedClassify(
      'Hello world this is a test document with nothing recognizable.',
      'randomfile.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('general');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to today's date — don't assert the exact day
  });

  it('dynamically accepts a new subcategory slug from the filename when it is genuinely grounded in the text', () => {
    const result = ruleBasedClassify(
      'Contrat Veolia Eau - consommation trimestrielle, montant total 32.10 EUR. Merci de votre confiance, Veolia.',
      'veolia_invoice.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('veolia');
  });
});
```

Update the `ai.service.js` import line (from Task 4) to the following complete line:

```ts
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify } from './ai.service.js';
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- ai.service`

Expected: all tests pass (19 from Tasks 2-4 + 8 new = 27). Every expected value here (including the two trickiest — the bank-statement guard in test 4, and the dictionary-fallback vendor test) was verified directly against the running function before being written into this plan.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai.service.test.ts
git commit -m "test: cover ruleBasedClassify — pay slips, bank-statement guard, vendor invoices, dynamic grounded slugs"
```

---

## Task 6: `ai.service.ts` — `classifyPDFText` (incl. `think:false` regression)

**Files:**
- Modify: `src/services/ai.service.test.ts`
- Test target: `src/services/ai.service.ts:544-796`

**Interfaces:**
- Consumes: `classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata>`. Internally calls `ensureOllamaModel()` → `ollama.list()` + `checkModelCanGenerate()` (which itself calls `ollama.generate()`) before its own `ollama.generate()` call. `checkModelCanGenerate` caches its result in a module-level singleton (`modelHealthCache`) for 5 minutes, keyed by model name — each test in this block must get a **fresh module instance** (via `vi.resetModules()` + dynamic import) so that cache doesn't leak between tests and skip the second `generate()` call.

- [ ] **Step 1: Add the hoisted Ollama mock and the `classifyPDFText` describe block**

Add this near the top of the file, after the `vi.mock('fs')` line and before the first `describe`:

```ts
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
```

Then add the describe block at the end of the file:

```ts
describe('classifyPDFText', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false); // categories.json/entity_dictionary.json absent -> built-in defaults
    listMock.mockResolvedValue({ models: [{ name: 'qwen3.5:9b' }] });
  });

  it('requests think:false from Ollama — regression guard for the 2026-07-30 bug where the model routed its whole JSON answer into response.thinking and left response.response empty', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe (checkModelCanGenerate)
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: '', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 's', tags: [], markdown_content: 'm',
        }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(generateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ think: false }));
  });

  it('parses a valid JSON response into DocumentMetadata (happy path)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: 'REF-1', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 'A vendor invoice',
          tags: ['sfr'], markdown_content: '# Facture',
        }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
    expect(result.titre).toBe('Facture SFR');
  });

  it('falls back to ruleBasedClassify when Ollama returns an empty response.response (the pre-fix failure shape)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' })
      .mockResolvedValueOnce({
        response: '',
        thinking: JSON.stringify({ titre: 'Facture SFR', categorie: 'invoices', subcategorie: 'sfr' }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    // classifyPDFText never reads response.thinking — this only resolves correctly via the
    // try/catch fallback to ruleBasedClassify, which independently recognizes 'sfr' + 'total ttc'.
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
  });
});
```

Also add `vi` to the vitest import if not already present from Task 3, and keep the existing `import fs from 'fs';` — both are shared across the whole file.

- [ ] **Step 2: Run and verify**

Run: `npm test -- ai.service`

Expected: all tests pass (27 from Tasks 2-5 + 3 new = 30). If test 1 (`think:false`) fails, check `src/services/ai.service.ts` around line 656-669 — `think: false` must be present in the `ollama.generate()` call inside `classifyPDFText`; it should already be there from this session's earlier bugfix. If it's missing, that's the actual regression this test exists to catch — add it back rather than changing the test.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai.service.test.ts
git commit -m "test: cover classifyPDFText incl. think:false regression guard and parse-failure fallback"
```

---

## Task 7: `config.ts`

**Files:**
- Create: `src/config.test.ts`
- Test target: `src/config.ts` (whole file)

**Interfaces:**
- Consumes: `loadCustomSettings(): object`, `CONFIG: { INPUT_DIR, OUTPUT_ROOT_DIR, OLLAMA_HOST, OLLAMA_MODEL, PERSONAL_NAME_DENYLIST, ... }`, `updateConfig(newSettings): void`, `reloadConfigFromDisk(): void`.
- `CONFIG` is derived once at module import time from `loadCustomSettings()`'s result — tests that need a specific initial `settings.json` content must use `vi.resetModules()` + dynamic `await import('./config.js')`, matching the exact pattern used for `classifyPDFText` in Task 6.

- [ ] **Step 1: Create `src/config.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

vi.mock('fs');

describe('config.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  describe('loadCustomSettings', () => {
    it('returns {} when settings.json does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadCustomSettings } = await import('./config.js');
      expect(loadCustomSettings()).toEqual({});
    });

    it('returns the parsed object when settings.json is valid JSON', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: 'X' }) as any);
      const { loadCustomSettings } = await import('./config.js');
      expect(loadCustomSettings()).toEqual({ input_dir: 'X' });
    });

    it('returns {} (not a throw) when settings.json is malformed', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{not valid json' as any);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { loadCustomSettings } = await import('./config.js');
      expect(loadCustomSettings()).toEqual({});
      consoleErrorSpy.mockRestore();
    });
  });

  describe('CONFIG derivation at module load', () => {
    it('picks up input_dir/output_root_dir/ollama_host/personal_name_denylist from settings.json', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          input_dir: '/custom/in',
          output_root_dir: '/custom/out',
          ollama_host: 'http://custom-host:1234',
          personal_name_denylist: ['Alice', ' Bob '],
        }) as any
      );
      const { CONFIG } = await import('./config.js');
      expect(CONFIG.INPUT_DIR).toBe('/custom/in');
      expect(CONFIG.OUTPUT_ROOT_DIR).toBe('/custom/out');
      expect(CONFIG.OLLAMA_HOST).toBe('http://custom-host:1234');
      expect(CONFIG.PERSONAL_NAME_DENYLIST).toEqual(['alice', 'bob']);
    });

    it('rejects an unsupported ollama_model and falls back to qwen3.5:9b (Golden Rule #14)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ollama_model: 'kimi-k3:cloud' }) as any
      );
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { CONFIG } = await import('./config.js');
      expect(CONFIG.OLLAMA_MODEL).toBe('qwen3.5:9b');
      consoleWarnSpy.mockRestore();
    });

    it('defaults PERSONAL_NAME_DENYLIST when settings.json has none', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG } = await import('./config.js');
      expect(CONFIG.PERSONAL_NAME_DENYLIST).toEqual(['dupond', 'martin', 'lefebvre', 'bernard']);
    });
  });

  describe('updateConfig', () => {
    it('mutates CONFIG in place and persists sanitized settings to disk', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG, updateConfig } = await import('./config.js');
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      updateConfig({ input_dir: '/new/in', ollama_model: 'not-allowed-model' });
      expect(CONFIG.INPUT_DIR).toBe('/new/in');
      expect(CONFIG.OLLAMA_MODEL).toBe('qwen3.5:9b');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        expect.stringContaining('"qwen3.5:9b"'),
        'utf-8'
      );
      consoleWarnSpy.mockRestore();
    });
  });

  describe('reloadConfigFromDisk', () => {
    it('re-reads settings.json and mutates the existing CONFIG object', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: '/first' }) as any);
      const { CONFIG, reloadConfigFromDisk } = await import('./config.js');
      expect(CONFIG.INPUT_DIR).toBe('/first');

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: '/second' }) as any);
      reloadConfigFromDisk();
      expect(CONFIG.INPUT_DIR).toBe('/second');
    });
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- config`

Expected: all 8 tests pass. If `updateConfig`'s test fails on the `fs.writeFileSync` assertion, check the actual argument shape logged by Vitest's diff — `writeFileSync(SETTINGS_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8')` per `src/config.ts:90`.

- [ ] **Step 3: Commit**

```bash
git add src/config.test.ts
git commit -m "test: cover config.ts — settings load/derive/update/reload, Golden Rule #14 model sanitization"
```

---

## Task 8: `document.schema.ts`

**Files:**
- Create: `src/schemas/document.schema.test.ts`
- Test target: `src/schemas/document.schema.ts` (whole file)

**Interfaces:**
- Consumes: `DocumentMetadataSchema`, `SystemSettingsSchema`, `CategoriesConfigSchema`, `SubcategorySchema`, `EntityDictionarySchema` (all Zod schemas, exported).

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect } from 'vitest';
import {
  DocumentMetadataSchema,
  SystemSettingsSchema,
  CategoriesConfigSchema,
  EntityDictionarySchema,
} from './document.schema.js';

describe('DocumentMetadataSchema', () => {
  it('parses a fully-populated valid object unchanged', () => {
    const input = {
      titre: 'Facture SFR', registre: 'REF-1', date: '2024-05-12',
      categorie: 'invoices', subcategorie: 'sfr', summary: 'A vendor invoice',
      tags: ['sfr', 'invoice'], markdown_content: '# Facture',
    };
    expect(DocumentMetadataSchema.parse(input)).toMatchObject(input);
  });

  it('rejects a missing titre', () => {
    expect(() => DocumentMetadataSchema.parse({ categorie: 'invoices' })).toThrow();
  });

  it('rejects a missing categorie', () => {
    expect(() => DocumentMetadataSchema.parse({ titre: 'Test' })).toThrow();
  });

  it('defaults optional fields when omitted', () => {
    const result = DocumentMetadataSchema.parse({ titre: 'Test', categorie: 'administrative' });
    expect(result.registre).toBe('');
    expect(result.date).toBe('');
    expect(result.subcategorie).toBe('');
    expect(result.summary).toBe('');
    expect(result.tags).toEqual([]);
    expect(result.markdown_content).toBe('');
    expect(result.other).toEqual({});
  });
});

describe('SystemSettingsSchema', () => {
  it('accepts qwen3.5:9b as ollama_model', () => {
    const input = {
      input_dir: '/in', output_root_dir: '/out',
      ollama_model: 'qwen3.5:9b', ollama_host: 'http://127.0.0.1:11434',
    };
    expect(SystemSettingsSchema.parse(input)).toMatchObject(input);
  });

  it('rejects any ollama_model other than qwen3.5:9b (Golden Rule #14)', () => {
    const input = {
      input_dir: '/in', output_root_dir: '/out',
      ollama_model: 'llama3', ollama_host: 'http://127.0.0.1:11434',
    };
    expect(() => SystemSettingsSchema.parse(input)).toThrow();
  });

  it('rejects a missing input_dir', () => {
    const input = { output_root_dir: '/out', ollama_model: 'qwen3.5:9b', ollama_host: 'h' };
    expect(() => SystemSettingsSchema.parse(input)).toThrow();
  });
});

describe('CategoriesConfigSchema', () => {
  it('parses nested subcategories recursively', () => {
    const input = {
      categories: [
        {
          id: 'invoices', name: 'Factures', aliases: ['facture'],
          subcategories: [
            { id: 'sfr', name: 'SFR', aliases: [], subcategories: [{ id: 'sfr_mobile', name: 'SFR Mobile' }] },
          ],
        },
      ],
    };
    const result = CategoriesConfigSchema.parse(input);
    expect(result.categories[0].subcategories[0].subcategories[0].id).toBe('sfr_mobile');
  });

  it('rejects a category with no id', () => {
    expect(() =>
      CategoriesConfigSchema.parse({ categories: [{ name: 'Factures' }] })
    ).toThrow();
  });
});

describe('EntityDictionarySchema', () => {
  it('defaults missing domains to empty arrays', () => {
    const result = EntityDictionarySchema.parse({ banks: [{ slug: 'ca', name: 'Crédit Agricole' }] });
    expect(result.banks).toHaveLength(1);
    expect(result.energy).toEqual([]);
    expect(result.telecom).toEqual([]);
    expect(result.insurance).toEqual([]);
    expect(result.gov).toEqual([]);
    expect(result.health).toEqual([]);
  });

  it('defaults an entity item aliases to an empty array when omitted', () => {
    const result = EntityDictionarySchema.parse({ banks: [{ slug: 'ca', name: 'Crédit Agricole' }] });
    expect(result.banks[0].aliases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- document.schema`

Expected: all 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/schemas/document.schema.test.ts
git commit -m "test: cover document.schema.ts Zod schemas incl. Golden Rule #14 ollama_model refine"
```

---

## Task 9: `triage.service.ts` — `isYearString` / `isForbiddenSubcategory` / `computeCanonicalPath`

**Files:**
- Create: `src/services/triage.service.test.ts`
- Test target: `src/services/triage.service.ts:107-143`

**Interfaces:**
- Consumes: `isYearString(str?: string): boolean`, `isForbiddenSubcategory(subcategory?: string): boolean`, `computeCanonicalPath(originalPath: string, category: string, subcategory?: string, dateStr?: string): string`. `computeCanonicalPath` references `CONFIG.OUTPUT_ROOT_DIR` — tests reference the same real `CONFIG` object directly (no `fs` mocking needed; assertions are built relative to `CONFIG.OUTPUT_ROOT_DIR`, not a hardcoded path, so they're correct regardless of what's in this machine's `settings.json`).

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect } from 'vitest';
import path from 'path';
import { isYearString, isForbiddenSubcategory, computeCanonicalPath } from './triage.service.js';
import { CONFIG } from '../config.js';

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
  it('builds category/subcategory/year/filename under CONFIG.OUTPUT_ROOT_DIR', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', 'sfr', '2024-05-12');
    expect(result).toBe(path.join(CONFIG.OUTPUT_ROOT_DIR, 'invoices', 'sfr', '2024', 'facture.pdf'));
  });

  it('falls back to the current year when dateStr has no 20xx year', () => {
    const result = computeCanonicalPath('C:\\raws\\facture.pdf', 'invoices', 'sfr', undefined);
    const currentYear = new Date().getFullYear().toString();
    expect(result).toBe(path.join(CONFIG.OUTPUT_ROOT_DIR, 'invoices', 'sfr', currentYear, 'facture.pdf'));
  });

  it('coerces a bare-year subcategory to "general" instead of nesting under a year folder', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'administrative', '2023', '2024-01-01');
    expect(result).toBe(path.join(CONFIG.OUTPUT_ROOT_DIR, 'administrative', 'general', '2024', 'doc.pdf'));
  });

  it('defaults an empty category to "other" and empty subcategory to "general"', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', '', '', '2024-01-01');
    expect(result).toBe(path.join(CONFIG.OUTPUT_ROOT_DIR, 'other', 'general', '2024', 'doc.pdf'));
  });

  it('splits a subcategory containing a slash into nested path segments', () => {
    const result = computeCanonicalPath('C:\\raws\\doc.pdf', 'invoices', 'foo/bar', '2024-01-01');
    expect(result).toBe(path.join(CONFIG.OUTPUT_ROOT_DIR, 'invoices', 'foo', 'bar', '2024', 'doc.pdf'));
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npm test -- triage.service`

Expected: all 14 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/triage.service.test.ts
git commit -m "test: cover triage.service.ts taxonomy/path helpers (Golden Rule #4/#5 enforcement)"
```

---

## Task 10: Full-suite verification and docs update

**Files:**
- Modify: `CLAUDE.md` (Scripts section)

**Interfaces:** None — this task verifies everything built in Tasks 1-9 and documents the new command.

- [ ] **Step 1: Run the full suite**

Run: `npm test`

Expected: all 63 tests across 4 files (30 in `ai.service.test.ts`, 8 in `config.test.ts`, 11 in `document.schema.test.ts`, 14 in `triage.service.test.ts`) pass, exit code 0.

- [ ] **Step 2: Confirm no type regressions**

Run: `npm run build`

Expected: `tsc` completes with no errors (test files are excluded from the build via `tsconfig.json`'s `rootDir`/`include` unless they were accidentally placed outside `src/` — confirm the build still only compiles application code, not test files, by checking `dist/` after the build doesn't contain `*.test.js`).

If `tsc` tries to compile `*.test.ts` files and fails on Vitest-only globals, add `"exclude": ["src/**/*.test.ts"]` to `tsconfig.json` and re-run.

- [ ] **Step 3: Add `npm test` to CLAUDE.md's Scripts section**

In `CLAUDE.md`, find the `## Scripts` section (currently listing `npm run dev`, `npm start`, `npm run scan`, `npm run mcp`, `npm run build`) and add, after the `npm run build` line:

```markdown
- `npm test` — run the Vitest unit test suite (pure classification/path/schema logic; see `docs/superpowers/specs/2026-07-31-test-harness-design.md`).
- `npm run test:watch` — Vitest in watch mode for local development.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document npm test / npm run test:watch in CLAUDE.md Scripts section"
```

- [ ] **Step 5: Final check**

Run: `npm test && npm run build`

Expected: both succeed. This is the Phase 1 exit criterion from the spec — a passing test suite plus a clean build, with no behavior change to the currently-working pipeline.
