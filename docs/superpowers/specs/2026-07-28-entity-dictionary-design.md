# Entity Dictionary for Category/Subcategory Auto-Creation

> ⚠️ **Historical record.** Personal entity names in this document (employers, schools, banks, practitioners) have been replaced with fictional placeholders. Real values live in the gitignored `.prompts.private.json` overlay — see [taxonomy](../../knowledge/taxonomy.md#personal-prompt-overlay).


Date: 2026-07-28
Owner: classification-expert

## Problem

`categories.json` accumulates junk subcategories over time: `Dcyjxe9mt9i7un7tolhu`,
`Dupond`, `Titrenom`, `Page`, `Bon`, `Exemple`, `Export`. These are not
hallucinations from Qwen — they trace to `ruleBasedClassify()`'s last-resort
branch (`src/services/ai.service.ts:239-249`), which fires when the Ollama
call fails/times out and no other regex signal matched: it takes the first
filename word ≥3 chars that isn't a stopword and slugifies it directly into
a new subcategory, with zero validation that it names a real entity.

Separately, Qwen's own prompt (`classifyPDFText`, same file) only knows about
entities hardcoded inline in the system prompt string (STEP 1-13) plus
whatever is already in `categories.json`. Adding a new recognized entity today
means editing a long prompt string by hand, and the prompt has no reference
list distinguishing "know these are real, prefer their canonical slug" from
"anything else, invent something clean."

## Goal

Give the classifier (both Qwen's prompt and the deterministic fallback) a
curated, maintainable reference of real-world French entities — so it's more
likely to name a new subcategory after an actual bank/insurer/energy provider/
government agency it recognizes, rather than inventing an ID from filename noise.
This is **soft guidance**, not a hard validation gate: genuinely new/unlisted
entities can still be auto-created (Golden Rule #5 — pre-move dynamic auto-create
stays in effect), we're just improving the odds of a clean name.

Explicitly out of scope: cleaning up the ~30 junk entries already sitting in
`categories.json` (separate task if wanted later).

## 1. `entity_dictionary.json` (new file, project root)

Domain-grouped reference of entities sourced from public French market data:
bank market-share rankings (BNP Paribas, Société Générale, Crédit Agricole,
BPCE, Crédit Mutuel — ~85% of retail banking; La Banque Postale; online banks
Boursorama/Fortuneo/Hello bank/Monabanq/N26/Revolut), energy suppliers beyond
EDF/Engie (TotalEnergies, Ekwateur, Mint Énergie, Ohm Énergie, Octopus Energy,
Vattenfall, Plenitude), the 4 ARCEP-licensed telecom MNOs and their low-cost
brands (Orange/Sosh, SFR/RED, Bouygues Telecom/B&You, Free), common household
insurers (AXA, MAIF, MACIF, MAAF, Groupama, Matmut, GMF, Generali, Direct
Assurance), social/admin agencies (CAF, CNAV, CARSAT, MSA, Préfecture, ANTS),
and health orgs (Alan, Harmonie Mutuelle, Malakoff Humanis).

Entries already present as real subcategories in `categories.json` today
(sfr, edf, northwind_realty, credit_mutuel, societe_generale, bnp_paribas, boursobank,
lcl, la_banque_postale, impot, urssaf, france_travail, ameli, northstar_sante,
lakeside_dental, allianz, cdiscount, fnac, northwind, summit, lakeside, openacademy)
are deliberately excluded — this file only adds what's missing, kept to
~40 entries so prompt size stays small.

Shape:

```json
{
  "banks":     [{ "slug": "axa_banque", "name": "...", "aliases": ["..."] }],
  "energy":    [...],
  "telecom":   [...],
  "insurance": [...],
  "gov":       [...],
  "health":    [...]
}
```

Each domain implicitly maps to a target category:
`banks` / `gov` → `administrative`, `energy` / `telecom` → `invoices`,
`insurance` → `insurance`, `health` → `health`.

## 2. Qwen prompt injection (`classifyPDFText`)

- `getEntityDictionary()`: reads and parses `entity_dictionary.json`, same
  pattern as `getCategoriesConfig()` (no in-memory cache — file is tiny,
  read fresh per classification call, consistent with how categories.json
  is already handled).
- `buildEntityHintLine(categoryId)`: filters dictionary entries by domains
  mapped to `categoryId`, returns `"slug (Name), slug (Name), ..."`.
- The `categoriesDescriptionStr` builder (line 276-279) gains one more
  clause per category, appended after `Existing subcategories: [...]`:
  `Known real-world entities: axa (AXA), maif (MAIF), ...`.
- No schema change. No new `DocumentMetadata` field. Pure prompt text.

## 3. Fallback alignment (`ruleBasedClassify`)

- The same dictionary is used to extend the existing per-domain `else-if`
  branches (bank branch, insurance branch, vendor/invoice branch — lines
  164-200) plus new branches for gov/energy/telecom aliases, so if Ollama
  is unreachable and the deterministic fallback fires, it recognizes "AXA",
  "URSSAF", "TotalEnergies" etc. the same way Qwen's prompt does.
- The last-resort filename-word branch (lines 239-249) is left in place
  as the final fallback for text matching nothing at all — it's not being
  removed, just given more chances to be bypassed by a real match first.
- Satisfies the existing Golden Rule that prompt and `ruleBasedClassify`
  stay logically aligned (same priority order / same known entities).

## Verification

- `npm run build` (tsc) — no type errors.
- Manual trace: pick sample text snippets naming entities newly added to
  the dictionary (e.g. "AXA", "TotalEnergies", "CAF") that previously had
  no matching branch, confirm they'd now resolve via dictionary-driven
  regex before reaching the filename-word fallback.
- `qa-reviewer` pass against the classification-expert done-when checklist
  (docs/agents/classification-expert.md) after implementation.
