# Entity Dictionary for Category/Subcategory Auto-Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the classifier (Qwen's prompt AND the deterministic `ruleBasedClassify` fallback) a curated reference of real-world French entities (banks, energy/telecom providers, insurers, gov/social agencies, health orgs) so new categories/subcategories it invents are more likely to be clean, recognizable names instead of filename noise.

**Architecture:** A new static `entity_dictionary.json` at project root, domain-grouped and Zod-validated. `ai.service.ts` loads it and uses it in two places: (1) appended as a "known entities" hint per category in Qwen's system prompt, (2) used by a new `matchEntityDictionary()` helper wired into `ruleBasedClassify`'s existing priority chain so the deterministic fallback recognizes the same entities. Soft guidance only — no hard validation gate, no schema change to `DocumentMetadata`.

**Tech Stack:** TypeScript, Zod, Node `fs`. No new dependencies. No test framework exists in this repo (`package.json` has no test script/devDependency) — verification is via small throwaway `tsx` scripts run and deleted per task, not a permanent test suite.

## Global Constraints

- Soft guidance only: dictionary matches bias naming, never block auto-creation of a genuinely new entity (Golden Rule #5 — pre-move dynamic auto-create still runs for anything not in the dictionary or `categories.json`).
- No schema change to `DocumentMetadata` / no new AI JSON output field (Golden Rule #19 — Zod schemas are the contract).
- Prompt and `ruleBasedClassify` stay logically aligned, same priority order (Golden Rule #6/#7 — deep semantic reading, company-level separation, never lump).
- Only Qwen 3.5 (`qwen3.5:9b`) — this change touches prompt text only, never model selection (Golden Rule #14).
- No new npm dependencies. No test framework introduced — this repo has none today.
- `entity_dictionary.json` only adds entities NOT already present as real subcategories in `categories.json` today (sfr, edf, foncia, credit_mutuel, societe_generale, bnp_paribas, boursobank, lcl, la_banque_postale, impot, urssaf, france_travail, ameli, gan_sante, clinic_x, allianz, cdiscount, fnac, ecole_x, ecole_y, ecole_z, openclassrooms are excluded).
- Reference spec: `docs/superpowers/specs/2026-07-28-entity-dictionary-design.md`.

---

## Task 1: Entity dictionary data file + Zod schema + config path

**Files:**
- Create: `entity_dictionary.json` (project root)
- Modify: `src/schemas/document.schema.ts` (add `EntityItemSchema`, `EntityDictionarySchema`, and inferred types, near the existing `CategoriesConfigSchema` around line 27-29)
- Modify: `src/config.ts` (add `ENTITY_DICTIONARY_FILE` to `CONFIG`, line 26 area, right after `CATEGORIES_FILE`)

**Interfaces:**
- Produces: `EntityItemSchema` (Zod), `EntityDictionarySchema` (Zod), `EntityItem` type (`{ slug: string; name: string; aliases: string[] }`), `EntityDictionary` type (`{ banks: EntityItem[]; energy: EntityItem[]; telecom: EntityItem[]; insurance: EntityItem[]; gov: EntityItem[]; health: EntityItem[] }`). `CONFIG.ENTITY_DICTIONARY_FILE: string`.

- [ ] **Step 1: Create `entity_dictionary.json` at project root**

```json
{
  "banks": [
    { "slug": "credit_agricole", "name": "Crédit Agricole", "aliases": ["credit agricole", "ca"] },
    { "slug": "caisse_epargne", "name": "Caisse d'Épargne", "aliases": ["caisse d'epargne", "caisse epargne", "bpce"] },
    { "slug": "fortuneo", "name": "Fortuneo", "aliases": ["fortuneo"] },
    { "slug": "hello_bank", "name": "Hello bank!", "aliases": ["hello bank", "hellobank"] },
    { "slug": "monabanq", "name": "Monabanq", "aliases": ["monabanq"] },
    { "slug": "n26", "name": "N26", "aliases": ["n26"] },
    { "slug": "revolut", "name": "Revolut", "aliases": ["revolut"] }
  ],
  "energy": [
    { "slug": "totalenergies", "name": "TotalEnergies", "aliases": ["totalenergies", "total energies", "total direct energie"] },
    { "slug": "ekwateur", "name": "Ekwateur", "aliases": ["ekwateur"] },
    { "slug": "mint_energie", "name": "Mint Énergie", "aliases": ["mint energie", "mint énergie"] },
    { "slug": "ohm_energie", "name": "Ohm Énergie", "aliases": ["ohm energie", "ohm énergie"] },
    { "slug": "octopus_energy", "name": "Octopus Energy", "aliases": ["octopus energy", "octopus"] },
    { "slug": "vattenfall", "name": "Vattenfall", "aliases": ["vattenfall"] },
    { "slug": "plenitude", "name": "Plenitude", "aliases": ["plenitude", "eni"] }
  ],
  "telecom": [
    { "slug": "orange", "name": "Orange", "aliases": ["orange"] },
    { "slug": "sosh", "name": "Sosh", "aliases": ["sosh"] },
    { "slug": "bouygues_telecom", "name": "Bouygues Telecom", "aliases": ["bouygues telecom", "bouygues", "b&you", "b and you"] },
    { "slug": "free", "name": "Free", "aliases": ["free", "free mobile"] },
    { "slug": "red_by_sfr", "name": "RED by SFR", "aliases": ["red by sfr"] }
  ],
  "insurance": [
    { "slug": "axa", "name": "AXA", "aliases": ["axa"] },
    { "slug": "maif", "name": "MAIF", "aliases": ["maif"] },
    { "slug": "macif", "name": "MACIF", "aliases": ["macif"] },
    { "slug": "maaf", "name": "MAAF", "aliases": ["maaf"] },
    { "slug": "groupama", "name": "Groupama", "aliases": ["groupama"] },
    { "slug": "matmut", "name": "Matmut", "aliases": ["matmut"] },
    { "slug": "gmf", "name": "GMF", "aliases": ["gmf"] },
    { "slug": "generali", "name": "Generali", "aliases": ["generali"] },
    { "slug": "direct_assurance", "name": "Direct Assurance", "aliases": ["direct assurance"] }
  ],
  "gov": [
    { "slug": "caf", "name": "CAF", "aliases": ["caf", "caisse d'allocations familiales", "allocations familiales"] },
    { "slug": "cnav", "name": "CNAV", "aliases": ["cnav", "assurance retraite"] },
    { "slug": "carsat", "name": "CARSAT", "aliases": ["carsat"] },
    { "slug": "msa", "name": "MSA", "aliases": ["msa", "mutualite sociale agricole"] },
    { "slug": "prefecture", "name": "Préfecture", "aliases": ["prefecture", "préfecture"] },
    { "slug": "ants", "name": "ANTS", "aliases": ["ants", "agence nationale des titres securises"] }
  ],
  "health": [
    { "slug": "alan", "name": "Alan", "aliases": ["alan"] },
    { "slug": "harmonie_mutuelle", "name": "Harmonie Mutuelle", "aliases": ["harmonie mutuelle"] },
    { "slug": "malakoff_humanis", "name": "Malakoff Humanis", "aliases": ["malakoff humanis", "malakoff", "humanis"] }
  ]
}
```

- [ ] **Step 2: Add the Zod schema to `src/schemas/document.schema.ts`**

Insert right after the existing `CategoriesConfigSchema` block (after line 29, `});`):

```typescript
export const EntityItemSchema = z.object({
  slug: z.string().min(1, "Entity slug is required"),
  name: z.string().min(1, "Entity name is required"),
  aliases: z.array(z.string()).optional().default([])
});

export const EntityDictionarySchema = z.object({
  banks: z.array(EntityItemSchema).optional().default([]),
  energy: z.array(EntityItemSchema).optional().default([]),
  telecom: z.array(EntityItemSchema).optional().default([]),
  insurance: z.array(EntityItemSchema).optional().default([]),
  gov: z.array(EntityItemSchema).optional().default([]),
  health: z.array(EntityItemSchema).optional().default([])
});

export type EntityItem = z.infer<typeof EntityItemSchema>;
export type EntityDictionary = z.infer<typeof EntityDictionarySchema>;
```

- [ ] **Step 3: Add the config path in `src/config.ts`**

Change line 26 area from:

```typescript
  CATEGORIES_FILE: path.join(BASE_DIR, 'categories.json'),
```

to:

```typescript
  CATEGORIES_FILE: path.join(BASE_DIR, 'categories.json'),
  ENTITY_DICTIONARY_FILE: path.join(BASE_DIR, 'entity_dictionary.json'),
```

- [ ] **Step 4: Write and run a throwaway verification script**

Create `<project-root>/_verify_task1.ts`:

```typescript
import fs from 'fs';
import { EntityDictionarySchema } from './src/schemas/document.schema.js';
import { CONFIG } from './src/config.js';

const raw = fs.readFileSync(CONFIG.ENTITY_DICTIONARY_FILE, 'utf-8');
const parsed = EntityDictionarySchema.parse(JSON.parse(raw));

const total = Object.values(parsed).reduce((sum, arr) => sum + arr.length, 0);
console.log('Domains:', Object.keys(parsed));
console.log('Total entities:', total);

if (total !== 37) throw new Error(`Expected 37 entities, got ${total}`);
if (parsed.insurance.find(e => e.slug === 'axa') === undefined) throw new Error('axa missing from insurance domain');
if (parsed.gov.find(e => e.slug === 'caf') === undefined) throw new Error('caf missing from gov domain');

console.log('TASK 1 VERIFICATION PASSED');
```

Run: `npx tsx _verify_task1.ts`
Expected output ends with `TASK 1 VERIFICATION PASSED`. If it throws, fix the schema or JSON file and re-run.

- [ ] **Step 5: Delete the throwaway script and commit**

```bash
rm _verify_task1.ts
git add entity_dictionary.json src/schemas/document.schema.ts src/config.ts
git commit -m "feat: add entity_dictionary.json with Zod schema and config path"
```

(This repo is not currently a git repository — if `git commit` fails with "not a git repository", skip the commit and just confirm the three files are saved.)

---

## Task 2: Dictionary loader, category map, and matcher helpers in `ai.service.ts`

**Files:**
- Modify: `src/services/ai.service.ts` (add new exports near `getCategoriesConfig`/`normalizeSlug`, lines 1-96)

**Interfaces:**
- Consumes: `EntityDictionarySchema`, `EntityDictionary`, `EntityItem` from `../schemas/document.schema.js` (Task 1). `CONFIG.ENTITY_DICTIONARY_FILE` (Task 1).
- Produces: `getEntityDictionary(): EntityDictionary`, `buildEntityHintLine(categoryId: string): string`, `matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[]): { categorie: string; subcategorie: string } | null`, `ALL_ENTITY_DOMAINS: (keyof EntityDictionary)[]` constant listing all 6 domain keys.

- [ ] **Step 1: Update the import line at the top of `src/services/ai.service.ts`**

Change:

```typescript
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem } from '../schemas/document.schema.js';
```

to:

```typescript
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../schemas/document.schema.js';
```

- [ ] **Step 2: Add the loader, domain map, hint builder, and matcher right after `saveCategoriesConfig` (after line 47, before `ensureOllamaModel`)**

```typescript
const DOMAIN_CATEGORY_MAP: Record<keyof EntityDictionary, string> = {
  banks: 'administrative',
  energy: 'invoices',
  telecom: 'invoices',
  insurance: 'insurance',
  gov: 'administrative',
  health: 'health'
};

export const ALL_ENTITY_DOMAINS = Object.keys(DOMAIN_CATEGORY_MAP) as (keyof EntityDictionary)[];

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

export function buildEntityHintLine(categoryId: string): string {
  const dict = getEntityDictionary();
  const domains = ALL_ENTITY_DOMAINS.filter(domain => DOMAIN_CATEGORY_MAP[domain] === categoryId);
  const entries = domains.flatMap(domain => dict[domain]);
  if (entries.length === 0) return '';
  return ` Known real-world entities: ${entries.map(e => `${e.slug} (${e.name})`).join(', ')}.`;
}

export function matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[]): { categorie: string; subcategorie: string } | null {
  const dict = getEntityDictionary();
  for (const domain of domains) {
    const categorie = DOMAIN_CATEGORY_MAP[domain];
    for (const entry of dict[domain]) {
      const candidates = [entry.name, ...entry.aliases];
      for (const candidate of candidates) {
        const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped.length === 0) continue;
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(combined)) {
          return { categorie, subcategorie: entry.slug };
        }
      }
    }
  }
  return null;
}
```

- [ ] **Step 3: Write and run a throwaway verification script**

Create `<project-root>/_verify_task2.ts`:

```typescript
import { getEntityDictionary, buildEntityHintLine, matchEntityDictionary, ALL_ENTITY_DOMAINS } from './src/services/ai.service.js';

const dict = getEntityDictionary();
console.log('Loaded domains:', Object.keys(dict));

const insuranceHint = buildEntityHintLine('insurance');
console.log('Insurance hint:', insuranceHint);
if (!insuranceHint.includes('axa')) throw new Error('Expected "axa" in insurance hint line');

const invoicesHint = buildEntityHintLine('invoices');
if (!invoicesHint.includes('orange') || !invoicesHint.includes('totalenergies')) {
  throw new Error('Expected telecom/energy entities in invoices hint line');
}

const noHint = buildEntityHintLine('reports');
if (noHint !== '') throw new Error('Expected empty hint line for a category with no dictionary domain');

const axaMatch = matchEntityDictionary('facture axa assurance habitation 2026', ['insurance']);
if (!axaMatch || axaMatch.subcategorie !== 'axa' || axaMatch.categorie !== 'insurance') {
  throw new Error(`Expected axa/insurance match, got ${JSON.stringify(axaMatch)}`);
}

const noMatch = matchEntityDictionary('some random text with no known entity', ALL_ENTITY_DOMAINS);
if (noMatch !== null) throw new Error(`Expected no match, got ${JSON.stringify(noMatch)}`);

console.log('TASK 2 VERIFICATION PASSED');
```

Run: `npx tsx _verify_task2.ts`
Expected output ends with `TASK 2 VERIFICATION PASSED`.

- [ ] **Step 4: Delete the throwaway script and commit**

```bash
rm _verify_task2.ts
git add src/services/ai.service.ts
git commit -m "feat: add entity dictionary loader, category map, and matcher helpers"
```

---

## Task 3: Inject entity hints into the Qwen system prompt

**Files:**
- Modify: `src/services/ai.service.ts` (`classifyPDFText`, lines 271-290)

**Interfaces:**
- Consumes: `buildEntityHintLine(categoryId: string): string` (Task 2).
- Produces: `buildCategoriesDescriptionStr(categoriesConfig: ReturnType<typeof getCategoriesConfig>): string` — extracted so it's independently testable (the original inline `.map()` had no name and couldn't be unit-tested without a live Ollama call).

- [ ] **Step 1: Extract and modify the description-string builder**

Change (lines 275-279):

```typescript
  const categoriesConfig = getCategoriesConfig();
  const categoriesDescriptionStr = categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}]`;
  }).join('\n');
```

to:

```typescript
  const categoriesConfig = getCategoriesConfig();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig);
```

- [ ] **Step 2: Add the extracted, exported function right before `classifyPDFText` (before line 271)**

```typescript
export function buildCategoriesDescriptionStr(categoriesConfig: ReturnType<typeof getCategoriesConfig>): string {
  return categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    const entityHint = buildEntityHintLine(c.id);
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}].${entityHint}`;
  }).join('\n');
}

```

- [ ] **Step 3: Write and run a throwaway verification script**

Create `<project-root>/_verify_task3.ts`:

```typescript
import { buildCategoriesDescriptionStr } from './src/services/ai.service.js';

const fakeConfig = {
  categories: [
    { id: 'insurance', name: 'Assurances', description: 'Test', aliases: [], subcategories: [{ id: 'allianz', name: 'Allianz', aliases: [], subcategories: [] }] },
    { id: 'reports', name: 'Rapports', description: 'Test', aliases: [], subcategories: [] }
  ]
};

const result = buildCategoriesDescriptionStr(fakeConfig as any);
console.log(result);

if (!result.includes("Category 'insurance'")) throw new Error('Missing insurance category line');
if (!result.includes('axa (AXA)')) throw new Error('Missing axa entity hint in insurance line');
if (result.split('\n')[1].includes('Known real-world entities')) throw new Error('reports line should have no entity hint');

console.log('TASK 3 VERIFICATION PASSED');
```

Run: `npx tsx _verify_task3.ts`
Expected output ends with `TASK 3 VERIFICATION PASSED`.

- [ ] **Step 4: Delete the throwaway script, build, and commit**

```bash
rm _verify_task3.ts
npx tsc --noEmit
git add src/services/ai.service.ts
git commit -m "feat: inject known-entity hints into Qwen classification prompt"
```

`npx tsc --noEmit` must report no errors before committing.

---

## Task 4: Align `ruleBasedClassify` fallback with the dictionary

**Files:**
- Modify: `src/services/ai.service.ts` (`ruleBasedClassify`, lines 98-250)

**Interfaces:**
- Consumes: `matchEntityDictionary`, `ALL_ENTITY_DOMAINS` (Task 2).
- Produces: no new exports — behavioral change only, `ruleBasedClassify`'s signature (`(rawText: string, filename: string) => { categorie, subcategorie, title, date }`) is unchanged.

- [ ] **Step 1: Extend the health branch (lines 135-140)**

Change:

```typescript
  else if (/\b(santé|sante|médical|medical|soins|dentaire|pharmacie|attestation de droits|attestationam|ameli|sécurité sociale|securite sociale|cpam|mutuelle|hospitalisation)\b/i.test(combined)) {
    categorie = 'health';
    if (/\bameli|assurance maladie|cpam|attestationam\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\bgan\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bclinic_x|clinic_x\b/i.test(combined)) subcategorie = 'clinic_x';
  }
```

to:

```typescript
  else if (/\b(santé|sante|médical|medical|soins|dentaire|pharmacie|attestation de droits|attestationam|ameli|sécurité sociale|securite sociale|cpam|mutuelle|hospitalisation)\b/i.test(combined)) {
    categorie = 'health';
    if (/\bameli|assurance maladie|cpam|attestationam\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\bgan\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bclinic_x|clinic_x\b/i.test(combined)) subcategorie = 'clinic_x';
    else {
      const dictHealth = matchEntityDictionary(combined, ['health']);
      if (dictHealth) subcategorie = dictHealth.subcategorie;
    }
  }
```

- [ ] **Step 2: Extend the vendor invoices branch (lines 164-170) with telecom/energy**

Change:

```typescript
  else if (/\b(facture n°|facture no|facture|invoice|quittance|montant à payer|total ttc)\b/i.test(combined)) {
    categorie = 'invoices';
    if (/\bsfr\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf|engie\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
  }
```

to:

```typescript
  else if (/\b(facture n°|facture no|facture|invoice|quittance|montant à payer|total ttc)\b/i.test(combined)) {
    categorie = 'invoices';
    if (/\bsfr\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf|engie\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else {
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy']);
      if (dictVendor) subcategorie = dictVendor.subcategorie;
    }
  }
```

- [ ] **Step 3: Add a new Government & Social Agencies branch right after the taxes branch (after line 175, before the insurance branch on line 177)**

Insert:

```typescript
  // 7b. Government & Social Agencies
  else if (matchEntityDictionary(combined, ['gov'])) {
    const dictGov = matchEntityDictionary(combined, ['gov'])!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
```

- [ ] **Step 4: Extend the insurance branch (lines 177-180) to trigger on and assign the new insurers**

Change:

```typescript
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined)) {
    categorie = 'insurance';
    if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
  }
```

to:

```typescript
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined) || matchEntityDictionary(combined, ['insurance'])) {
    categorie = 'insurance';
    if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else {
      const dictInsurance = matchEntityDictionary(combined, ['insurance']);
      if (dictInsurance) subcategorie = dictInsurance.subcategorie;
    }
  }
```

(This also fixes a pre-existing latent bug: MACIF/MAAF were already in the trigger regex but had no subcategorie assignment, so they fell through to `'general'` and would have been BLOCKED by Golden Rule #4. They're now in `entity_dictionary.json`'s `insurance` domain, so they resolve correctly.)

- [ ] **Step 5: Extend the banks branch (lines 182-200) with the new banks**

Change the end of the chain from:

```typescript
  } else if (/\b(la banque postale|banque postale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'la_banque_postale';
  }
```

to:

```typescript
  } else if (/\b(la banque postale|banque postale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'la_banque_postale';
  } else if (matchEntityDictionary(combined, ['banks'])) {
    const dictBank = matchEntityDictionary(combined, ['banks'])!;
    categorie = dictBank.categorie;
    subcategorie = dictBank.subcategorie;
  }
```

- [ ] **Step 6: Give the dictionary one more chance before the filename-word last resort (lines 238-239)**

Change:

```typescript
    else if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else {
      // Dynamic Subcategory Extraction from Filename Words
```

to:

```typescript
    else if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else if (matchEntityDictionary(combined, ALL_ENTITY_DOMAINS)) {
      const dictAny = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS)!;
      categorie = dictAny.categorie;
      subcategorie = dictAny.subcategorie;
    }
    else {
      // Dynamic Subcategory Extraction from Filename Words
```

- [ ] **Step 7: Write and run a throwaway verification script**

Create `<project-root>/_verify_task4.ts`:

```typescript
import { ruleBasedClassify } from './src/services/ai.service.js';

function expect(label: string, actual: any, expected: any) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`OK: ${label}`);
}

// New entities resolve via the dictionary
let r = ruleBasedClassify('Facture AXA Assurance Habitation - Montant à payer 120€', 'doc1.pdf');
expect('axa categorie', r.categorie, 'insurance');
expect('axa subcategorie', r.subcategorie, 'axa');

r = ruleBasedClassify('CAF - Caisse d\'Allocations Familiales - notification de droits', 'doc2.pdf');
expect('caf categorie', r.categorie, 'administrative');
expect('caf subcategorie', r.subcategorie, 'caf');

r = ruleBasedClassify('Facture TotalEnergies - Montant à payer', 'doc3.pdf');
expect('totalenergies categorie', r.categorie, 'invoices');
expect('totalenergies subcategorie', r.subcategorie, 'totalenergies');

r = ruleBasedClassify('Relevé de compte Crédit Agricole SOLDE CREDITEUR', 'doc4.pdf');
expect('credit_agricole categorie', r.categorie, 'administrative');
expect('credit_agricole subcategorie', r.subcategorie, 'credit_agricole');

r = ruleBasedClassify('Attestation mutuelle Harmonie Mutuelle remboursement soins', 'doc5.pdf');
expect('harmonie_mutuelle categorie', r.categorie, 'health');
expect('harmonie_mutuelle subcategorie', r.subcategorie, 'harmonie_mutuelle');

// Pre-existing bug fix: MACIF now resolves instead of falling to 'general'
r = ruleBasedClassify('Facture assurance habitation MACIF', 'doc6.pdf');
expect('macif categorie', r.categorie, 'insurance');
expect('macif subcategorie', r.subcategorie, 'macif');

// Regression: existing well-known entities still work unchanged
r = ruleBasedClassify('Caisse de Credit Mutuel RELEVE DE COMPTE SOLDE CREDITEUR', 'doc7.pdf');
expect('credit_mutuel unchanged categorie', r.categorie, 'administrative');
expect('credit_mutuel unchanged subcategorie', r.subcategorie, 'credit_mutuel');

// Regression: unmatched gibberish still falls to filename-word extraction, not a crash
r = ruleBasedClassify('random unrelated content with no signals at all', 'Dcyjxe9mt9i7un7tolhu.pdf');
expect('gibberish subcategorie', r.subcategorie, 'dcyjxe9mt9i7un7tolhu');

console.log('TASK 4 VERIFICATION PASSED');
```

Run: `npx tsx _verify_task4.ts`
Expected output ends with `TASK 4 VERIFICATION PASSED`.

- [ ] **Step 8: Delete the throwaway script, build, and commit**

```bash
rm _verify_task4.ts
npx tsc --noEmit
git add src/services/ai.service.ts
git commit -m "fix: align ruleBasedClassify fallback with entity dictionary, fix macif/maaf subcategory gap"
```

---

## Task 5: Documentation update

**Files:**
- Modify: `docs/knowledge/taxonomy.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add a new subsection after "Dynamic auto-creation" (after line 59, before "## Rename flow")**

Insert:

```markdown
## Entity dictionary (soft guidance)

`entity_dictionary.json` (project root) is a curated, hand-maintained reference
of real-world French entities (banks, energy/telecom providers, insurers,
gov/social agencies, health orgs) that aren't yet real subcategories in
`categories.json`. It's loaded by `ai.service.ts` and used two ways:

1. Injected into Qwen's system prompt as a "Known real-world entities" hint
   per category (`buildEntityHintLine` / `buildCategoriesDescriptionStr`), so
   Qwen prefers a recognized canonical slug over inventing one.
2. Consulted inside `ruleBasedClassify` (`matchEntityDictionary`) at the same
   priority points as the Qwen prompt — bank/insurance/vendor/gov/health
   branches, plus one more chance right before the last-resort filename-word
   extraction — so the deterministic Ollama-down fallback recognizes the same
   entities.

This is soft guidance only: a document naming an entity not in the dictionary
(and not already in `categories.json`) still gets a new subcategory
auto-created per Rule #5 — the dictionary only improves naming quality, it
never blocks auto-creation. To add an entity, add a `{slug, name, aliases}`
entry under the right domain (`banks`, `energy`, `telecom`, `insurance`,
`gov`, `health`) — no prompt-string or regex editing required.
```

- [ ] **Step 2: Commit**

```bash
git add docs/knowledge/taxonomy.md
git commit -m "docs: document the entity_dictionary.json soft-guidance mechanism"
```

---

## Self-Review Notes

- **Spec coverage:** entity_dictionary.json file (Task 1) ✅, Qwen prompt injection (Task 3) ✅, ruleBasedClassify alignment (Task 4) ✅, verification approach (each task's Step) ✅, docs (Task 5) ✅.
- **Placeholder scan:** none — every step has literal code/content.
- **Type consistency:** `matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[]): { categorie: string; subcategorie: string } | null` is the same signature used in Tasks 2 and 4. `buildEntityHintLine(categoryId: string): string` used identically in Tasks 2 and 3. `EntityDictionary`/`EntityItem` types from Task 1 flow unchanged through Tasks 2-4.
