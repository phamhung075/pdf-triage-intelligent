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
  - Employers: `employeur_x`, `globex`, `capgemini`, `ecole_x`.
  - Schools: `ecole_x`, `ecole_y`, `ecole_z`, `openclassrooms`.
  - Vendors: `sfr`, `edf`, `engie`, `free`, `cdiscount`, `amazon`, `bouygues`, `orange`, `veolia`.
  - Health: `ameli`, `gan_sante`, `clinic_x`.
  - Insurance: `allianz`, `macif`, `maaf`.
  - Housing: `foncia`, `justificatif_domicile`.
  - Identity types: `passeport`, `titre_sejour`, `carte_vitale`, `permis_conduire`, `carte_identite`, `acte_mariage`.
  - Tax: `impot`.
  - Contracts: `cdi_cdd`, `conditions_generales`, `attestation_employeur`.
- Forbidden as final subcategory: `general`, `other`, `divers`, empty string, year strings.
- Nesting allowed: `ecole_x/bachelor` maps to `education/ecole_x/bachelor/<YYYY>/`.

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
