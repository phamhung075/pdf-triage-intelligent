# 🧭 Classification Decision Flow

Strict priority order. The Ollama prompt in `classifyPDFText()` and `ruleBasedClassify()` **must stay logically aligned** — if you change one, change the other. If they diverge, [qa-reviewer](../agents/qa-reviewer.md) will reject the change.

## Step 0 — user overlay overrides

Before the 13 generic steps, both paths consult the gitignored `.prompts.private.json`: the prompt
as a rendered STEP 0 block, `ruleBasedClassify()` via `matchPriorityRules()`. This is where
personal signals live — statement filename codes, scan prefixes, an archive's own schools and
practitioners — so the committed prompt and classifier stay publishable.

⚠️ **Step 1 still wins.** A non-bank overlay rule never overrides a bank statement, so a landlord
or vendor name matched only inside a transaction row cannot pull the document out of `bank`.

See [taxonomy](../knowledge/taxonomy.md#personal-prompt-overlay).

## The 13 steps

Evaluated top-down. First match wins.

### 1. Bank statements

Header signals: `Crédit Mutuel`, `Société Générale`, `BNP Paribas`, `BoursoBank`, `LCL`, `La Banque Postale`, `RELEVE DE COMPTE`, `SOLDE CREDITEUR`, IBAN.

Bank-specific statement filename codes and account-product names are personal, so they are not in the committed prompt — they come from `.prompts.private.json` as a STEP 0 override (see [taxonomy](../knowledge/taxonomy.md#personal-prompt-overlay)).

→ `category = bank`, `subcategory = <bank_slug>` (`credit_mutuel`, `societe_generale`, …).

`bank` is what both code paths actually produce: `DOMAIN_CATEGORY_MAP.banks` in [`src/domain/classification.ts`](../../src/domain/classification.ts) maps the dictionary's `banks` domain to `bank`, and the archive on disk is filed as `bank/bnp_paribas`, `bank/credit_mutuel`. This step previously documented `administrative`, which no path has ever emitted.

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

Signals: `Contrat de travail`, `CDI`, `CDD`, `Avenant au contrat`, `Conditions générales`, `Notice employeur`, `Convention collective`.

→ `category = contracts`, `subcategory` = work/conditions/company (`cdi_cdd`, `conditions_generales`, `attestation_employeur`).

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
