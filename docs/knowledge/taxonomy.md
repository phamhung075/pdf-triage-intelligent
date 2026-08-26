# 📚 Category Taxonomy

Source of truth: `categories.json` at project root. Rules for classification: [classification-flow](../workflows/classification-flow.md).

## Baseline categories

Defined as defaults in `getCategoriesConfig()` (`src/infrastructure/categories-store.ts`) when `categories.json` is missing or invalid.

| Slug              | Name                | Purpose                                    |
| ----------------- | ------------------- | ------------------------------------------ |
| `invoices`        | Factures            | Vendor invoices, receipts                  |
| `bulletin_salaire`| Bulletins de Salaire| Pay slips, subcategorized per employer     |
| `contracts`       | Contrats            | Employment / rental / vendor contracts     |
| `administrative`  | Administratif       | Bank statements, taxes, government forms   |
| `health`          | Santé               | Medical, mutuelle, Ameli, pharmacy         |
| `identity`        | Identité            | Passports, CNI, titre de séjour, permis    |
| `housing`         | Logement            | Domicile proofs, rent quittances           |
| `insurance`       | Assurances          | Auto/habitation/prévoyance policies        |
| `education`       | Éducation           | Diplomas, formations, scolarité            |
| `recruitment`     | Recrutement         | CVs, lettres de motivation                 |
| `correspondence`  | Courriers           | Postal letters, emails, notifications      |
| `technical`       | Technique           | Manuals, technical guides                  |
| `reports`         | Rapports            | Project reports, syntheses                 |

## Subcategory naming rules

- Lowercase snake_case slug.
- One entity per slug — **never lump**.
  - Banks: `credit_mutuel`, `societe_generale`, `bnp_paribas`, `boursobank`, `lcl`, `la_banque_postale`.
  - Employers: the slugified employer name printed on the pay slip (`acme_corp`, `globex_sarl`, …).
  - Schools: the slugified school or training-provider name (`northwind_academy`, …).
  - Vendors: `sfr`, `edf`, `engie`, `free`, `cdiscount`, `amazon`, `bouygues`, `orange`, `veolia`.
  - Health: `ameli`, `cpam`, plus the slugified practitioner/mutuelle name.
  - Insurance: `allianz`, `macif`, `maaf`.
  - Housing: `justificatif_domicile`, plus the slugified property-manager name.
  - Identity types: `passeport`, `titre_sejour`, `carte_vitale`, `permis_conduire`, `carte_identite`, `acte_mariage`.
  - Tax: `impot`.
  - Contracts: `cdi_cdd`, `conditions_generales`, `attestation_employeur`.
- Forbidden as final subcategory: `general`, `other`, `divers`, empty string, year strings.
- Nesting allowed: `<school_slug>/bachelor` maps to `education/<school_slug>/bachelor/<YYYY>/`.

## Cross-category traps

| Trap                                       | Correct outcome                                             |
| ------------------------------------------ | ----------------------------------------------------------- |
| Bank statement lists an SFR transaction    | `administrative/<bank_slug>` — ignore inner rows            |
| Pay slip mentions a vendor                 | `bulletin_salaire/<employer_slug>` — never `invoices`       |
| Tax notice looks like a letter             | `administrative/impot` — never `correspondence`             |
| Attestation d'employeur                    | `contracts/attestation_employeur`                           |
| Attestation de stage from an employer      | `education/<school_or_employer_slug>` — not `contracts`     |

## Dynamic auto-creation

When Qwen returns a category or subcategory that isn't in `categories.json`:

1. `normalizeSlug()` sanitizes it.
2. New entry appended with Title-Cased `name`, `aliases: [slug]`, empty `subcategories`.
3. `saveCategoriesConfig()` writes & triggers `CATEGORIES_UPDATED` SSE.
4. THEN the file is moved. Never reorder these steps.

## Entity dictionary (soft guidance)

`entity_dictionary.json` (project root) is a curated, hand-maintained reference
of real-world French entities (banks, energy/telecom providers, insurers,
gov/social agencies, health orgs) that aren't yet real subcategories in
`categories.json`. It's loaded by `entity-dictionary-store.ts` and used two ways:

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

## Personal prompt overlay

Everything under `prompts/` is **committed and publishable**, so it carries no real
employer, bank product code, scan filename prefix, clinic, or school belonging to the
person running this instance. Those signals are still useful to the classifier, so they
live in a gitignored overlay and are injected at prompt-build time:

| File | Committed? | Holds |
| --- | --- | --- |
| `prompts/*.md`, `prompts/json_schema_response.json` | yes | the generic decision flow, generic examples, and two placeholders |
| `prompts.private.json.example` | yes | the template + inline documentation |
| `.prompts.private.json` | **no** (gitignored) | your real entities and keyword overrides |

The overlay feeds **both** classification paths, which is what keeps them logically aligned
(Golden Rule #6). `src/domain/prompt-personalization.ts` owns the shape, the rendering, and the
matcher; `src/infrastructure/prompt-personalization-store.ts` reads the file.

**Path 1 — the Qwen prompt.** Two placeholders:

- `{{USER_PRIORITY_RULES}}` in `prompts/classification_rules.md` — rendered as a **STEP 0**
  block *before* the generic STEP 1. The flow is strict-order and STEP 1 is a high-priority
  override, so an overlay block appended after STEP 13 would never fire for the document
  types these overrides exist to catch.
- `{{USER_KNOWN_ENTITIES}}` in `prompts/micro_prompt_entity.md` — recognition hints for
  Step A entity extraction.

**Path 2 — the deterministic fallback.** `matchPriorityRules()` runs the same rules inside
`ruleBasedClassify()` (`src/domain/classification.ts`), as a branch sitting between the
fines override and the bank-statement override. Without it the Ollama-down fallback would keep
classifying by signals the prompt no longer carries — a silent divergence.

Two rules govern the fallback path:

- **Only rules with an explicit `subcategory` apply.** A rule that defers subcategory resolution
  to the issuing entity gives a regex classifier nothing to resolve from, and inventing one would
  manufacture a subcategory the document never supported.
- **A non-bank rule never outranks a bank statement** (Golden Rule #6). A landlord or vendor name
  matched only inside a statement's transaction rows cannot pull the document out of `bank`. The
  rendered STEP 0 block states the same exception to the model in words.

Keyword matching excludes adjacent **letters**, not digits: `gan` must not fire inside
`organization`, but a statement code or scan prefix is routinely glued to a date or account number
(`STMT_CHK_101`), and a digit-excluding boundary would never match those. A keyword ending in a
separator (`stmt_`, `c/c `) needs no trailing guard at all.

Overlay shape (`known_entities`, `priority_rules`, `extra_rules_text`) is Zod-validated. A
missing file is the normal state for a fresh clone and both blocks render as the empty
string; an invalid file is logged and treated as empty rather than thrown, so a typo can
never take the triage pipeline down. Same public-base + private-overlay split as
`categories.json` / `.categories.private.json`.

Note that the overlay is often *redundant* for entity naming: `{{CATEGORIES_DESCRIPTION}}`
already injects the real, merged subcategory list (including everything auto-created from
your own documents), and `entity_dictionary.json` already supplies per-category entity
hints. Reach for `.prompts.private.json` for signals neither of those can express — bank
statement filename codes, scanner prefixes, bilingual document titles.

`src/domain/prompt-hygiene.test.ts` fails the build if any name from
`CONFIG.PERSONAL_NAME_DENYLIST` reappears in a committed `prompts/` file **or** in
`src/domain/classification.ts`, and asserts the classifier still reads its overrides through
`matchPriorityRules` rather than hardcoding them.

## Rename flow

`POST /api/subcategories/rename` — atomically:
- Update `categories.json` (rename or add).
- Update every matching DB row's `subcategory`.
- Relocalize each physical file to the new canonical path.
- Broadcast `REGISTRY_UPDATED` + `CATEGORIES_UPDATED`.

## Adding a new category by hand

1. Edit `categories.json` (or via Settings modal `PUT /api/categories`).
2. Restart the web server (or wait for the auto-watcher tick).
3. The next Qwen prompt will include the new category in `categoriesDescriptionStr`.
