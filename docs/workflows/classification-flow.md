# 🧭 Classification Decision Flow

Strict priority order. The Ollama prompt in `classifyPDFText()` and `ruleBasedClassify()` **must stay logically aligned** — if you change one, change the other. If they diverge, [qa-reviewer](../agents/qa-reviewer.md) will reject the change.

## Step 0 — user overlay overrides

Before the 13 generic steps, both paths consult the gitignored `.prompts.private.json`: the prompt
as a rendered STEP 0 block, `ruleBasedClassify()` via `matchPriorityRules()`. This is where
personal signals live — statement filename codes, scan prefixes, an archive's own schools and
practitioners — so the committed prompt and classifier stay publishable.

⚠️ **Steps 1–3 still win.** A STEP 0 override never overrides a bank statement, a tax notice or a
pay slip when its target category disagrees with what the document actually is: a landlord or
vendor name matched only inside a transaction row cannot pull the document out of `bank`, and a
generic keyword like `paiement`/`échéance` cannot pull an *avis d'impôt* or a *taxe foncière*
notice into `invoices` (this is the 2026-08-31 regression — two tax notices were filed under
`invoices/cdiscount` and `housing/foncia` because auto-learned rules fired on the notices' body
text). Property-tax detection is notice-level: `taxe foncière` alone is not enough (Foncia
quittances list it among the recoverable charges) — it needs a second tax-authority signal.

⚠️ **Auto-learned rules are filename-scoped.** Rules derived from human move decisions
(`manual_decisions` → `decisionsToPriorityRules`) only match the *filename* of future documents,
never body text, and generic money-movement words (`paiement`, `échéance`, `calendrier`,
`credit`, `mandat`, `sepa`, …) are rejected at derivation. A hand-curated rule in
`.prompts.private.json` matches text or filename as before — keep those distinctive (codes and
entity names), never generic single words.

See [taxonomy](../knowledge/taxonomy.md#personal-prompt-overlay).

## The 13 steps

Evaluated top-down. First match wins.

### 1. Bank statements

Header signals: `Crédit Mutuel`, `Société Générale`, `BNP Paribas`, `BoursoBank`, `LCL`, `La Banque Postale`, `RELEVE DE COMPTE`, `SOLDE CREDITEUR`, IBAN.

Bank-specific statement filename codes and account-product names are personal, so they are not in the committed prompt — they come from `.prompts.private.json` as a STEP 0 override (see [taxonomy](../knowledge/taxonomy.md#personal-prompt-overlay)).

→ `category = bank`, `subcategory = <bank_slug>` (`credit_mutuel`, `societe_generale`, …).

`bank` is what both code paths actually produce: `DOMAIN_CATEGORY_MAP.banks` in the `classification` package
(`services/pdf-triage-pdf2w/classification`) maps the dictionary's `banks` domain to
`bank`, and the archive on disk is filed as `bank/bnp_paribas`, `bank/credit_mutuel`. This step previously documented `administrative`, which no path has ever emitted.

⚠️ **Ignore vendor names inside transaction rows** (SFR, PayPal, Amazon, Lidl). Header wins.

### 2. Tax documents

Signals: `Avis d'impôt`, `Avis d'imposition`, `Prélèvements sociaux`, `Revenus <YYYY>`, `Finances Publiques`, `DGFIP`, `Taxe foncière`, `Taxe d'habitation`.

→ `category = administrative`, `subcategory = impot`.

⚠️ **Never `correspondence`** for tax notices.

### 3. Pay slips

Signals: `Bulletin de salaire`, `Bulletin de paie`, `Fiche de paie`, `Salaire brut`, `Net à payer`.

→ `category = bulletin_salaire`, `subcategory = <employer_slug>` — the slugified employer name printed on the pay slip (`acme_corp`, `globex_sarl`, …).

⚠️ **Never `invoices`**.

### 4. Health & medical

Signals: `Ameli`, `Assurance Maladie`, `CPAM`, `Mutuelle`, `Ordonnance`, `Soins Dentaires`, `Pharmacie`, `Hospitalisation`.

→ `category = health`, `subcategory` = institution (`ameli`, `cpam`, or the slugified practitioner / mutuelle name).

### 5. Identity & civil papers

Signals: `Passeport`, `Carte d'Identité`, `CNI`, `Titre de Séjour`, `Carte Vitale`, `Permis de conduire`, `Acte de mariage`, `Acte de naissance`.

→ `category = identity`, `subcategory` = document type (`passeport`, `titre_sejour`, `carte_vitale`, `permis_conduire`, `carte_identite`, `acte_mariage`).

### 6. Housing & domicile proof

Signals: `Justificatif de domicile`, `Attestation d'hébergement`, `Quittance de loyer`, `Logement`, `Bail d'habitation`, `Attestation titulaire de contrat 2DDoc`.

→ `category = housing`, `subcategory = justificatif_domicile` or the slugified property-manager name.

### 7. General insurance

Signals: `Assurance Auto`, `Assurance Habitation`, `Prévoyance`, `Responsabilité Civile`, `Allianz`, `Macif`, `Maaf`.

→ `category = insurance`, `subcategory = <company_slug>` (`allianz`, …).

### 8. Vendor invoices (Factures)

Signals: `Facture n°`, `Invoice`, `Montant à payer`, `Total TTC`, plus a vendor name — `SFR`, `EDF`, `Engie`, `Free`, `Orange`, `Cdiscount`, `Amazon`.

→ `category = invoices`, `subcategory = <vendor_slug>` (`sfr`, `edf`, `cdiscount`, `amazon`, …).

### 9. Contracts & general conditions

Signals: `Contrat de travail`, `CDI`, `CDD`, `Avenant au contrat`, `Mandat de prélèvement SEPA`, `SEPA mandate`, `Conditions générales`, `Notice employeur`, `Convention collective`.

→ `category = contracts`, `subcategory` = work/conditions/company (`cdi_cdd`, `conditions_generales`, `attestation_employeur`, `mandat_sepa`).

### 10. Education & academic

Signals: `Attestation de stage`, `Certificat de scolarité`, `Diplôme`, `Bachelor`, `Relevé de notes`, `Attestation de formation`.

→ `category = education`, `subcategory` = school / training-provider slug, or `releve_notes` / `alternance` / `diplomes`.

### 11. Recruitment

Signals: `Lettre de motivation`, `CV`, `Curriculum Vitae`, `Candidature`, `Postuler`.

→ `category = recruitment`, `subcategory = lettres_motivation`.

### 12. Postal mail & emails

Fallback: plain letters or emails without invoice / tax / contract context.

→ `category = correspondence`. Subcategory must still be a specific slug — sender name, subject slug, etc. Never `general`.

### 13. Technical / reports

Technical guides → `category = technical`. Project reports → `category = reports`.

## TypeSafe decision step (optional)

Runs after Step D has produced a classification. TypeSafe (System One / Jev) is wired whenever a
`typesafe_api_key` / `TYPESAFE_AI_API` (and optional `typesafe_model` / `TYPESAFE_MODEL`) is
present in Settings; the composition root injects a small adapter that re-reads
`settingsStore.Config()` on every call and builds or reuses one `typesafe.Client` per key+model, so
a key or model change takes effect **without a restart**. With an empty key the adapter returns a
no-key sentinel and the pipeline behaves exactly as before TypeSafe existed: no request, no
per-file warning. It never touches Steps A/C/D — the title, summary, date, amounts and markdown
still come from the DeepSeek/Ollama path.

One System One request decides the category and every speculative subcategory from the existing
taxonomy.

### Confidence policy

The floor is `typesafe_min_confidence` (default `0.6`), raised to `0.85` when Step D's result is a
priority classification: `bank`, `bulletin_salaire`, `administrative` with subcategory `impot`, or
any result produced by the Step A entity-priority override (Golden Rules 6/7).

| TypeSafe category answer | Result |
| --- | --- |
| agreeing with Step D, or answering `none` | Step D's category is kept |
| differing, confidence ≥ the floor | TypeSafe's category wins |
| differing, confidence below the floor | **BLOCK** — the file is moved to `__raws/.blocked_files`, a `blocked_files` row is written with reason `typesafe_disagreement`, `FILE_FAILED` is emitted, and the file stays out of `__archive` with no DB row (same terminal semantics as Golden Rules 3/4) |

When TypeSafe overrides the category it must confidently pick an **existing** subcategory of the new
category. If it proposes a new one, answers below the floor, or the new category has none, the file
is blocked for review rather than having Step D's old-category slug carried across. A
category-only TypeSafe answer (no confident subcategory) does **not** suppress the rule-based rescue
for an ungrounded `general` subcategory.

A TypeSafe outage is logged and Step D's result is kept — a classification never fails because
TypeSafe did.

### Pre-creation existence check

Before auto-creating a new category or subcategory (Golden Rule 5), one TypeSafe request compares
the proposed slug against the existing entries: an entry naming the same organism or document type
— an old/new name of the same issuer, e.g. Pôle emploi → France Travail — is reused instead of
creating a second instance, and the mapping is recorded as a taxonomy hint. Subcategory options are
keyed `<category>/<slug>` and restricted to the proposed category when the taxonomy has more than
254 entries. A match is reused only when its probability is at or above the confidence floor; a
below-floor answer or a TypeSafe outage falls back to the deterministic duplicate guard, exactly as
before TypeSafe existed.

The new taxonomy entry is saved once, after the subcategory existence check. When that check
re-files the document into another existing category, the tentatively appended new category is
dropped instead of being persisted as an empty orphan; Golden Rule 5 still holds because whatever
category/subcategory the document finally lands in is saved before the move.

The threshold is `typesafe_min_confidence` / `TYPESAFE_MIN_CONFIDENCE`
(see [environment](../knowledge/environment.md#typesafe-system-one--jev)).

### New category naming

When a new top-level category would be auto-created, TypeSafe is configured, and the existence
check above found no existing match, one further TypeSafe request names it (Golden Rule 5). Jev
cannot generate text, so the candidate names are built in code: the primary provider's proposed
slug, Step A's extracted document type (slugified), and the committed generic catalogue
`newCategoryCatalogue` — `vehicle`, `retirement`, `legal`, `family`, `transport`, `taxes_business`,
`utilities`. A candidate is dropped before the request when its slug already exists as a category id
(the tentative proposal is excluded), when the strict guard forbids it (empty / `general` / `other` /
`divers` / `autre` / a bare year), or when the near-duplicate / entity-as-category guard blocks it.

One `choice` request offers the surviving candidates plus `aucune`. A candidate chosen with
probability at or above the confidence floor (`typesafe_min_confidence`, default `0.6`) replaces the
tentative category: a catalogue entry keeps its curated French name and description, a
provider/Step A slug keeps the auto-created naming convention, and a taxonomy hint records the
replacement when the chosen id differs from the provider's slug. `aucune`, a below-floor answer or
an empty candidate set blocks the file for manual review — the same `__raws/.blocked_files` +
`blocked_files` row + `FILE_FAILED` path as the confidence policy above — and nothing is saved. A
TypeSafe error or a missing key keeps the pre-TypeSafe behaviour and creates the provider's slug.

The step exists to stop junk auto-created categories — a generic `general` bucket or an organism
name — from entering the private overlay.

## Deep semantic reading

Never classify on a single keyword. The prompt enforces:

1. **Header vs body audit** — the issuer wins over line items.
2. **Full-content purpose analysis** — read for legal / financial / administrative intent.
3. **Category selection** — strict order above.
4. **Specific subcategory** — the exact company / bank / school / gov branch. Auto-generate a slug if unknown.

## Strict fail guard

If, after all this, the subcategory is empty / `general` / `other` / `divers` / a year → BLOCK. Keep file in `__raws`, emit `FILE_FAILED`, do not insert a DB row. See Golden Rule #4.

## Owner

[classification-expert](../agents/classification-expert.md).
