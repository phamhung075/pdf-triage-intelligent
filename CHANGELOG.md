# Changelog

All notable changes to this project are recorded here, grouped by date and
topic (not strict SemVer — this is a local-first personal tool, not a
published package). Newest first. Each entry links back to the commit(s) it
summarizes; run `git show <hash>` for the full diff.

This file is maintained going forward as part of the docs single-source-of-truth
set (see [CLAUDE.md](CLAUDE.md) and [docs/README.md](docs/README.md)): every
future change of any real size gets an entry here, written at the same time
as the code/doc change, not reconstructed later from `git log`.

## Unreleased

### Taxonomy duplicate guard — block + return hint to the local agent

Prevents the "same subcategory under several categories" problem from coming back after the
2026-08-27 one-instance merge. The classifier previously only searched for a slug inside the
matched category, so a slug living under another category — or a variant spelling of an existing
slug — fell through to dynamic auto-creation and wrote a SECOND instance of the same entity.

- **`src/domain/taxonomy-conflicts.ts`** (new): pure detection, checked before any auto-creation.
  - exact / alias match under another category → remap to the canonical owner (e.g. `foncia`
    proposed under `invoices` → `housing/foncia`);
  - near-duplicate spelling (normalized edit distance ≥ 0.82, min length 4; short slugs never
    fuzzy-matched) — same-category variants merge onto the existing slug (`bouyguestelecom` →
    `bouygues_telecom`), cross-category ones re-file to the canonical owner;
  - entity name proposed as a top-level category (`france_travail`) → filed under its real
    subcategory home (`administrative/france_travail`); near-duplicate category names
    (`administratif` → `administrative`) remapped the same way.
- **Block wired in** `resolveCategory`/`resolveSubcategory` (`classification-resolution.ts`): a
  conflict returns the existing entry with `isNew: false` and a `conflict` descriptor — nothing is
  created, no `saveCategoriesConfig` write, no duplicate on disk. The agent path
  (`classify-document.ts`) re-files the document to the canonical category and logs
  `[TAXONOMY_GUARD]`.
- **Hint returned to the agent**: every block is recorded in the gitignored `taxonomy_hints.json`
  (`src/infrastructure/taxonomy-hints-store.ts`, newest 50, deduplicated) and re-injected into the
  model's `{{USER_PRIORITY_RULES}}` STEP 0 block on every future run
  (`renderTaxonomyConflictHintsBlock` via `prompt-personalization-store.ts`) — a concrete
  "do not create X, always use Y" list. `prompts/classification_rules.md` carries the same rule as
  a static "TAXONOMY INTEGRITY" guard.
- **Tests**: `src/domain/taxonomy-conflicts.test.ts` (unit) + duplicate-guard cases in
  `classification-resolution.test.ts`. `npm test`: 852 passing; the 15 remaining failures are
  pre-existing environment-dependent ones (Windows-path assertions on POSIX hosts, Tesseract/OCR
  availability, `.env` PaddleOCR override, and two in the WIP-modified `web-server.test.ts`) —
  none touch the new guard.
- **Runtime-data fix**: disabled two stale auto-learned feedback rules in `manual_decisions.json`
  that mapped `sfr`/`orange` to a non-existent `telecom` category (they were misrouting real SFR
  invoices and made `refineClassification` tests environment-dependent).

### Subcategory merge — one instance per subcategory (cross-category de-duplication)

Every subcategory slug now lives under **exactly one** category. Sixteen slugs had been
auto-created under several categories at once (e.g. `foncia` under invoices+contracts+housing,
`pro_electro` under contracts+education+bulletin_salaire, `france_travail`/`pole_emploi` under
4 categories each), so the taxonomy manager and dashboard tree showed the same subcategory
repeated in different categories.

- **Canonical mapping applied** (driven by document contents): `alternance`→education,
  `amende`→administrative, `by_conseil`→bulletin_salaire, `caisse_des_depots`→bank, `cesi`→education,
  `dgfip`→administrative, `foncia`→housing, `france_travail`→administrative, `hopital_st_joseph`→invoices,
  `lai_dentail`→bulletin_salaire, `openclassrooms`→education, `pole_emploi`→administrative,
  `pro_electro`→bulletin_salaire, `service_public`→administrative,
  `tribunal_administratif_marseille`→correspondence, `urssaf`→administrative.
- **Same-entity spellings folded**: `laposte`→`la_poste` (correspondence), `prefecture_bouches-du-rhone`→`prefecture`
  (administrative), `sarl_le_pacifique`→`pacifique4` (bulletin_salaire); old slugs kept as aliases so
  lookups still resolve.
- **`france_travail` top-level category removed** (it was an AI auto-created category for an entity):
  its docs/subcategories (`france_travail`, `pole_emploi`, `allocation`, `mes_candidatures`) fold into
  `administrative`, matching the gov-agency convention (urssaf, dgfip, inpi…).
- **Migration** (`scripts/merge-subcategories.ts`, one-shot, idempotent, dry-run by default): 63
  documents updated in SQLite, their physical files relocalized in `__archive` via the app's own
  `relocalizeFileIfNeeded` logic, empty source dirs pruned, `registry.json` regenerated. One pay slip
  misfiled under `bulletin_salaire/service_public` was re-filed to `bulletin_salaire/pacifique4`.
  Backups of the DB, registry and private taxonomy taken under `.tmp-gt/merge-backup-*`.
- With every slug having a single owner, `findCanonicalCategoryForSubcategory` (Repair Registry) now
  resolves all of these deterministically instead of declining on ambiguity.

### Relocalize modal — generic, taxonomy-wide reason dropdowns

The "Why is the Category / Location wrong?" and "Why is the Subcategory wrong?" dropdowns in the
📍 Relocalize modal previously offered only a handful of very specific misclassification pairs
(e.g. "Bank Account Statement misclassified as Vendor Invoice (Internal transaction line issue)"),
which covered few real cases and pushed everything else into the free-text note. Replaced with
generic reason families:

- **Category** — one option per top-level category (`bank`, tax/gov, `bulletin_salaire`, `health`,
  `insurance`, `identity`, `housing`, invoices, `contracts`, `education`, `recruitment`,
  `correspondence`, technical/reports) plus the cross-cutting root causes: issuer-vs-transaction
  confusion, OCR misreads on scans, merged multi-document PDFs, non-FR/EN language, and
  "Category is correct — only the subcategory / location is wrong".
- **Subcategory** — generic fallback used, wrong/misspelled organization name, entity missing from
  dictionary (needs creation), too-generic slug, wrong document-type subcategory, filename-echoed
  slug, date/random numbers in slug, and "Subcategory is correct — keep it as-is".

Also strengthened the feedback-teaches-AI loop (Golden Rule #18): `combineRelocalizeReasons()`
now appends `Target: <cat>/<sub>` when the user moved the target away from the document's current
values (so `previousError` tells Qwen the intended result instead of echoing the wrong one), re-
combines when the category/subcategory/custom-subcategory controls change, and focuses the free-text
note when a `__CUSTOM__` reason is chosen so a typed reason is never silently dropped.

- `public/index.html` — new dropdown option lists + grammar-polished labels.
- `public/ts/ModalsManager.ts` — enhanced `combineRelocalizeReasons()` + listeners; compiled to
  `public/js/ModalsManager.js` via `npm run build:frontend`.
- `docs/workflows/relocalize.md` — documents the reason families, the `Target:` suffix, and the
  correct UI file refs (`public/ts/ModalsManager.ts`, not the stale `public/app.js`).

### Human decisions now TEACH future runs — 🧠 "Human Decisions" tab in System Config

Closed the loop flagged in the previous entry: a relocalize reason was forwarded to Qwen only for
the document being moved, then parked in `manual_decisions` where nothing ever re-read it. Now every
human decision is registered AND injected into the AI's **STEP 0 private priority block** on future
classifications, so a correction generalizes to the rest of the archive:

- **`src/domain/decision-rule.ts`** (new, pure) — `deriveRuleKeywords()` extracts conservative match
  keywords from the moved document's filename + title (filename codes / scanner prefixes first, with
  a French/English stopword list and digit/year filtering — a keyword must identify the issuer, never
  the document type); `decisionsToPriorityRules()` maps enabled decisions (newest 25) to STEP 0 rules,
  skipping forbidden target subcategories (Golden Rule #4) and decisions with no usable keyword.
- **`src/infrastructure/manual-decisions-store.ts`** — `recordManualDecision()` now derives and stores
  `rule_keywords` + an `enabled` flag (DB columns `rule_keywords` / `enabled`, migrated in
  `src/infrastructure/db/database.ts`; legacy rows stay active and derive keywords lazily). New
  `updateManualDecision()`, `deleteManualDecision()`, `clearManualDecisions()` and the synchronous
  `readManualDecisionsSync()` (mtime-cached) that keeps the prompt path DB-free. The DB id is now
  stamped onto the JSON mirror record so both stores stay in sync.
- **`src/infrastructure/prompt-personalization-store.ts`** — `getPromptPersonalization()` appends the
  enabled decisions to `priority_rules` (after the hand-curated `.prompts.private.json` rules), so the
  Qwen prompt **and** the `ruleBasedClassify()` fallback (`matchPriorityRules`) both see them and stay
  aligned (Golden Rule #6). No scan/restart needed — the prompt reads the store on every build.
- **HTTP** (`src/infrastructure/http/web-server.ts`) — `PUT /api/manual-decisions/:id`,
  `DELETE /api/manual-decisions/:id`, `DELETE /api/manual-decisions`, all broadcasting
  `DECISIONS_UPDATED` SSE.
- **UI** — third tab "🧠 Human Decisions & AI Feedback" in ⚙️ System Config (`public/index.html`,
  `public/ts/ModalsManager.ts`): review every decision (target old→new, reason, collapsible text
  snippet), toggle Teaching-AI on/off, edit target/reason/keywords inline, delete one or all. Compiled
  to `public/js/*.js` via `npm run build:frontend`.
- **Tests** — `src/domain/decision-rule.test.ts` (new), `src/infrastructure/manual-decisions-store.test.ts`
  (update/delete/clear/keyword tests), `src/infrastructure/prompt-personalization-store.test.ts` (new).
- **Docs** — `docs/workflows/relocalize.md` ("How a decision teaches future runs"),
  `docs/knowledge/taxonomy.md` (private-overlay table + loop), `AGENTS.md` layout comments.

### Docs bootstrap unified — `AGENTS.md` is the single root file; `CLAUDE.md` symlinks to it

The project previously had two overlapping root instruction files (`CLAUDE.md` bootstrap + `AGENTS.md`
directives) that duplicated each other and the `docs/` tree. Merged into one:

- **`AGENTS.md`** is now the single root bootstrap for every agent: it combines the old `CLAUDE.md`
  bootstrap (project description, repo layout, scripts) and the `AGENTS.md` directives, **retired the
  duplicated rule text** (the 20 directives and the 11-step classification flow now live only in
  `docs/knowledge/golden-rules.md` and `docs/workflows/classification-flow.md`) and replaced it with a
  **lazy-loading context map**: one-line rule anchors + links to the authoritative `docs/` files, loaded
  on demand. Also fixed stale wording (auto-creation target is `.categories.private.json`, not
  `categories.json`; classification flow is the 13-step doc).
- **`CLAUDE.md` is now a symlink → `AGENTS.md`** — every agent tool (Claude Code, Codex, Cursor) reads
  the same instructions; edit the target, never the link.
- Cross-references updated: `docs/README.md`, `docs/agents/README.md`, `docs/agents/docs-curator.md`,
  and the `pid-lock.ts` comment now point at `AGENTS.md` and document the symlink. Historical plan/spec
  docs under `docs/superpowers/` were left untouched.

### WSL path handling centralised (Golden Rule #21) — reusable, guarded, documented

The Windows/WSL path fixes were scattered across `settings.ts` and three ad-hoc spawn sites, so the
next "open this folder" feature could easily reintroduce the same bug. Refactored into two owned
modules with a build-failing hygiene guard:

- **`src/domain/path-conversion.ts`** (pure, zero I/O) — `windowsToWslPath` (was `normalizePathInput`),
  `wslToWindowsPath` (was `toWindowsPath`) and `isWslMountPath`. `settings.ts` now just re-exports
  them under the historical names, so all existing importers and tests keep working.
- **`src/infrastructure/os-open.ts`** — the ONLY module allowed to launch a file manager or Chrome:
  `revealInFileManager` / `openDirectory` / `openInChrome` return spawn-ready `{ cmd, args }` with
  platform branching (Windows Explorer / macOS Finder / WSL explorer.exe interop / xdg-open) and the
  WSL→Windows conversion built in. `resolveChromeExecutable` probes `/mnt/c` under WSL.
- **All call sites migrated** — `/api/open-location`, the document "open folder" route,
  `/api/open-chrome` in `web-server.ts`, and the MCP `open_document_folder` tool (which also stops
  using shell-interpolated `exec()` — same spawn-array security rule as the web routes).
- **`src/infrastructure/os-open.hygiene.test.ts`** — fails the build if an `explorer.exe` /
  `chrome.exe` / `xdg-open` literal appears in any source file outside `os-open.ts`. A future "open
  button" that spawns a launcher directly cannot merge.
- **Docs** — Golden Rule #21 (WSL path discipline), a "WSL path policy" section in
  `docs/knowledge/architecture.md`, and both modules in the `CLAUDE.md` layout.
- Tests: 22 new unit tests across `path-conversion.test.ts` / `os-open.test.ts` /
  `os-open.hygiene.test.ts`; full suite unchanged at the 15 pre-existing failures (none new).

### "Open Incoming / Open Archive" buttons now open the right folder under WSL

The buttons POST the configured folder to `/api/open-location`, which spawned `explorer.exe` with
the path as-is. On WSL that path is POSIX (`/mnt/c/Users/<user>/OneDrive/<docs>/__raws`);
Explorer is a Windows program that cannot resolve it and silently fell back to its default
location — `C:\Users\<user>\Documents`. Same class of bug in the PDF viewer and the
select-in-Explorer action.

- **`toWindowsPath()`** in `src/infrastructure/settings.ts` — the inverse of `normalizePathInput()`:
  rewrites `/mnt/<drive>/...` into `X:\...` (pure string transform; native-Windows and plain POSIX
  paths pass through unchanged). Unit-tested.
- **`/api/open-location`** — existence/stat checks stay on the POSIX path; `explorer.exe` now gets
  the converted Windows path (both the folder and the `-select` file branches, plus the parent-dir
  fallback).
- **document-card "open folder" route** — under WSL it now reveals the file in Windows Explorer via
  the converted path (interop) instead of `xdg-open`; `xdg-open` remains for non-/mnt paths.
- **`/api/open-chrome`** — Chrome gets the converted path, and the executable lookup also probes
  `/mnt/c/Program Files[...]` so it works when the env vars are Linux-side/empty.
- Full suite: same 15 pre-existing failures as before this change (none introduced).

### Imported the original registry from `D:\<user>\__projet\__master\pdf_triage`

The WSL working copy's database was empty (0 documents) while the original install on the D: drive
held the full registry — 861 documents with summaries, raw text, embeddings and the FTS5 index.
The original DB was imported (not moved — the D: source is untouched) and all stored paths were
migrated from Windows form to WSL form so file operations keep working on this host:

- **`pdf_triage.db`** — clean checkpointed copy of `D:\...\pdf_triage.db` (`VACUUM INTO`), with
  `original_path` / `new_path` / `source_image_path` rewritten `C:\Users\<user>\OneDrive\<docs>\...`
  → `/mnt/c/Users/<user>/OneDrive/<docs>/...` in `documents`, `documents_fts` and
  `blocked_files`. Verified: 861 documents, FTS search works, and sampled archive files exist at
  the migrated paths. FTS column layout matches the current code, so no index rebuild is triggered.
- **`registry.json`** — same migration applied to the JSON mirror (861 entries).
- **`manual_decisions.json`** — copied (no path fields).
- The previous empty DB is preserved as `pdf_triage.db.empty.bak` (plus `-wal`/`-shm` backups) in
  case anything needs to be recovered.
- The app must be restarted to load the imported DB.

### WSL path fix: Windows paths in settings no longer create literal backslash folders

`settings.json` held `\mnt\C:\Users\...` — a Windows-style path with backslashes. On Linux/WSL a
backslash is a legal filename character, so Node never resolved it to the OneDrive folder; instead
`ensureDirectoriesExist()` created real directories literally named `\mnt\C:\Users\...\__raws`
(and `C:\Users\...\__raws`) inside the project root, and the watcher scanned those empty stubs —
"the system config cannot see files on Windows".

- **settings.json** now uses the real WSL paths: `/mnt/c/Users/<user>/OneDrive/<docs>/__raws`
  (input) and `.../__archive` (output).
- **`normalizePathInput()`** in `src/infrastructure/settings.ts` converts any Windows spelling
  (`C:\...`, `\mnt\C:\...`, `/mnt/C/...`) into the lowercase `/mnt/<drive>/...` form on non-Windows
  hosts, at CONFIG load, on `reloadConfigFromDisk()` and on every `updateConfig()` save — so a path
  pasted into the Settings modal self-heals and can never recreate the literal-backslash folders.
  No-op on native Windows. Unit-tested in `settings.test.ts` (incl. a `platform` param so the
  conversion is exercisable on any host).
- Settings modal help text in `public/index.html` now shows `/mnt/c/...` placeholders and explains
  that Windows `C:\...` paths are auto-converted.
- Removed the 6 stray directories the bug had created in the project root (they contained only the
  auto-created empty `.blocked_files` / `.delete_files` / `.duplicates_files` stubs — no documents
  were trapped; verified before deletion).


### Taxonomy reconciled: 13 duplicate subcategories merged, 138 empty entries removed

The archive had accumulated the near-duplicate slugs predicted by the missing reconciliation check —
one entity split across two spellings because `normalizeSlug` has no near-duplicate lookup before
auto-creating. A scan comparing slugs with punctuation stripped found **13 collisions**; all are now
merged, moving **48 files**:

| category | merged away | into | result |
| --- | --- | --- | --- |
| bank | `marseille_ste_marguerite` (30) | `credit_mutuel` | 147 |
| bank | `societegenerale` (1) | `societe_generale` | 21 |
| invoices | `bouyguestelecom` (7) | `bouygues_telecom` | 12 |
| correspondence | `laposte` (7) | `la_poste` | 8 |
| correspondence | `avocat_x` (4) | `avocat_x` | 6 |
| correspondence | `caissedesdepots` (2) | `caisse_des_depots` | 2 |
| invoices | `commerce_x` (1) | `commerce_x` | 3 |
| invoices | `dentaire_x` (1) | `dentaire_x` | 2 |
| invoices | `fournisseur_y` (1) | `fournisseur_y` | 1 |
| insurance | `assureur_x` (1) | `assureur_x` | 2 |
| transport | `sn_cf` (1) | `sncf` | 1 |
| + `francetravail`, `cdiscountenergie`, `mika_baloo`, `objectifcode` | empty duplicates | | entries dropped |

`marseille_ste_marguerite` was not a spelling variant but a **branch location** promoted to an
entity: all 30 documents are "Caisse de Crédit Mutuel Marseille Ste Marguerite" statements on the
same account series, filed as if the branch were the bank. `sn_cf` and `fournisseur_y` are
the acronym-splitting damage (SNCF, GmbH) noted earlier.

Winners came from `entity_dictionary.json` where it has an entry (`france_travail`,
`caisse_des_depots`, `energie_x`), otherwise the brand's own spelling. The losing slug
survives as an alias on the winner so existing references still resolve.

Separately, **138 subcategory entries that no document used** were removed from
`.categories.private.json` (287 entries → 149, file 59KB → 33KB). Most were classifier noise
(`3_proe`, `proelectho`, `marbeille`, `sb_0321_sir`) that offered the resolver spurious targets to
match against. Entries defined in the committed `categories.json` are excluded from pruning by
construction — `saveCategoriesConfig` writes only the private overlay — and none were touched.

Also fixed: `POST /api/subcategories/rename` handled renames but not merges. Renaming into a
subcategory that already existed mutated the old entry's id in place, leaving **two entries sharing
one id** for every later lookup to guess between — and reconciling two spellings of one entity is
precisely when that endpoint gets used. The logic moved to a unit-tested pure function,
`mergeSubcategoryInTaxonomy` in `src/domain/taxonomy.ts`, which folds the loser's aliases into the
survivor and removes the duplicate.


### Bank statements lost transaction payee names, and nothing checked

Step C's contract is ZERO CONTENT SKIPPING, but nothing verified it. On one account extract,
`SOLDE CREDITEUR` (the closing balance, twice), `PARIS STORE`, `LES PALMIERS`, `SM CASINO` and
`JEFF DE BRUGES` are all absent from `markdown_content` while every one of the 14 `CARTE 08411144`
references on the same rows survived — payee names dropped, card numbers kept.

Quantified conservatively: **22 of 235 unambiguous merchant labels (9.4%) missing across 11 of 74
statements**. "Unambiguous" is doing real work there — a first pass said 41%, but most of that was
the probe failing to match labels the model had legitimately de-fused (`SOCIETE GENERALEMARSEILLE`
→ `SOCIETE GENERALE` + `MARSEILLE`). Only properly-spaced multi-word names, whose absence cannot be
explained by de-fusing, are counted.

New `measureContentRecall()` (`src/domain/markdown-tables.ts`) measures what share of the raw text's
distinctive tokens survive into the Markdown, and Step C logs a `WARN` below 80%. Threshold set from
the archive's own distribution: median recall ~95%, verified-loss documents 53–69%. Fires on ~9% of
measurable documents.

Validated in production on its first firing. Across the 36 documents triaged after it shipped,
exactly one fell below the threshold and exactly one `WARN` was emitted — no misses, no false
positives. That document (`Relevé ETALIS … 2018-09-30.pdf`, 79%, 21 of 101 tokens missing) had lost
a contiguous block of consumer-credit boilerplate: the mediator's contact details, "Sous réserve des
extournes ou annulations éventuelles", and the paragraph on requesting réduction / suspension /
résiliation and repaying without pénalité. Its `markdown_content` is 2,956 chars against 1,981 of
`raw_text` — **larger** — so the length ratio this check replaced would have reported it as healthy.
A second confident warning later caught the same shape on `sfr-facture-B521-008131334.pdf`, whose
legal footer (`Société Anonyme au capital de …`, the Espace Client identifier block) was absent from
perfectly un-fused source text.

The next hour's ingest showed the limit of that validation: a family of 17 BNP `RLV_CHQ_*`
statements all warned, and all were **false positives**. Their raw text is run-together
(`evolutionsmensuellesdevotrecomptecheques`, `bnpparibassaaucapitalde`, `bddesitaliens`) and the
Markdown had correctly split it, but the fusion guard did not trip — the document scores 21% long
tokens against 20% for a genuinely clean statement, so no document-level threshold can separate
them. Three alternative measures were tried and rejected: per-token artifact exclusion alone still
warned, and restricting recall to alphabetic words *hid* verified losses (the Bouygues invoices rose
to 98%, the account extract to 85%).

The confound is real: on fused source text, de-fusing and genuine loss are indistinguishable to any
token-level measure. Rather than keep tuning thresholds against a handful of hand-labelled
documents, the check now (a) ignores missing tokens that are themselves unambiguous fusion artifacts
— a run of 15+ characters, or a numeric run with several decimal commas — and (b) computes
`fusionSuspected`.

**A `WARN` is emitted only when fusion is NOT suspected.** Hedged warnings did not help: the
`RLV_CHQ_*` family kept producing about ten an hour, every one a false alarm, and a warning nobody
can act on trains people to skim past the ones that matter. The fused cases stay at `DEBUG` so an
audit can still find them. Across 618 measurable documents this is **5 warnings and 45 demoted**,
against 41 warnings before.

Known limit, stated rather than papered over: the remaining warnings are a triage hint, not a
verdict. `fusionSuspected` keys on long tokens and camel-case seams, so it misses documents fused
into short all-lowercase pairs — `Avis_de_taxes_foncieres_2025.pdf` still warns on tokens like
`payezen`, `survotre`, `boutonvert`, which are de-fusing rather than loss. Treat a warning as "open
this document", and do not add a further heuristic without a labelled corpus to test it against.

It refuses to measure heavily fused raw text, and that guard needed two attempts. Average token
length alone missed a real statement — `DateNaturedesoperationsValeurDebitCredit 12RUEQUELQUEPART`
scores only 18.9 because the surviving spaces drag the mean down — so fusion is now detected from
three angles (mean length, share of 15+ char tokens, share of tokens with a lowercase→uppercase
seam). Measured: fused documents score 49–95% long-token share against 7–20% for clean ones. Without
that, the warning fired on documents the pipeline had handled *correctly*: de-fusing makes raw tokens
unmatchable by construction, so `Lettre motivation.pdf` scores 15% recall while its Markdown is
strictly better than its raw text.

Separately visible in those fused documents, and **not** fixed: de-fusing invents details.
`12RUEQUELQUEPART` became "17 avenue de Luminy" (street number changed), `CHAMBRE1BATIMENTB`
dropped its room number entirely, and a fused phone/duration run `00336529500:00:09` yielded a
9-digit number where a French mobile needs 13. The disambiguation is genuinely underdetermined; the
fix belongs upstream in extraction, not in a guess.

### A short table row shifts every value one column left

Found by the hourly sweep on freshly-triaged Bouygues Telecom invoices. Their call-detail tables
came back with a five-column header and four-cell rows:

```
| Date | Heure | Numéro appelé | Unité(s) décomptée(s) | Coût € TTC* |
| 12/08 | 11:53:37 | 336528710 | 0,00 |
```

33 of 35 rows in one block, and 866 ragged rows across the archive. A short GFM row does not leave
the last column blank — it shifts every value one heading to the left, so each call's **cost is
filed under "Unité(s) décomptée(s)"**. That is wrong data, not wrong formatting.

Deliberately NOT auto-repaired: which cell is missing is undecidable from the output alone, and
padding by guess would fabricate a figure's meaning — exactly what the prompt's own rule 2b forbids.
Attacked from two sides instead:

- **Prompt.** `prompts/micro_prompt_markdown.md` gains rule **2c**: count a row's cells against the
  header before emitting it, emit an explicitly empty cell in the right position when the source has
  no value, and fall back to `**Label:** Value` lines rather than invent an alignment. Measured on
  the same invoice family before and after (6 invoices / 1,589 rows vs 5 / 1,402): ragged rows fell
  from **21.5% to 12.6%**. A real improvement, and not a fix — per-document variance is high (one
  pre-change invoice was already clean, one post-change invoice still sits at 27%), so treat the
  magnitude as directional. The model cannot be trusted to enforce this on its own.
- **Prompt, correcting the above.** Classifying all 201 ragged table blocks in the archive by shape
  showed rule 2c was giving the wrong instruction for the majority of them. The dominant failure is
  not a row missing a value: in **113 blocks (56%)** every data row agrees on a width and the HEADER
  is wider, because the model pulled a section title or a repeated row-label into it. A freshly
  ingested SFR call-detail invoice had 34 of 35 rows "ragged" purely because
  `| Compris dans vos forfaits | Session Data | Date | ... |` invented a column above rows that were
  perfectly self-consistent. Padding those rows to the header's width — what 2c asks for — preserves
  the wrong alignment and fabricates blank cells. New rule **2d** covers that case: when the rows
  agree and the header does not, drop the invented column and move the section title to a `###`
  heading above the table. Only 23 of 201 blocks (11%) are the shape 2c was written for; the
  remaining 65 (32%) have genuinely inconsistent rows. Baseline recorded for the next sweep:
  113 over-wide-header blocks of 201.
- **Detection.** New pure `auditMarkdownTables()` (`src/domain/markdown-tables.ts`) runs over the
  ASSEMBLED markdown — tables split across a chunk boundary only become visible once the pieces are
  joined — and Step C now logs a `WARN` naming the document, the ragged-row count and percentage,
  and any headerless block. It measures and never repairs, for the reason above. Previously the only
  way to discover this damage was to audit the database after the fact.

Existing affected documents need re-processing; their `raw_text` is intact.

### A chunk could exceed its own budget, and a truncated reply counted as a conversion

`Déclaration fiscale annuelle_20260130.pdf` extracted to 590,166 chars across only **320 lines**:
153 of them longer than the 1400-char chunk budget, the longest 13,860. `chunkText` appended an
over-long line whole rather than splitting it, so a single "chunk" carried ~14k chars into a model
whose `num_predict` caps the **response** at 4096 tokens. When generation stops at that cap the
reply is cut off mid-document but long and plausible, and the `length > 10` success gate accepted it
as a conversion.

> **Correction.** Earlier revisions of this entry claimed this had truncated that document's stored
> Markdown to "6% of raw_text", and several hourly sweep reports repeated a `markdown_content /
> raw_text` ratio as a content-loss measure. That measure is invalid. These France Travail / Pôle
> Emploi PDFs extract to text that is **92–99% whitespace** — `raw_text` 590,166 chars carries only
> 8,145 non-whitespace characters — so a low length ratio says nothing about lost content. Measured
> properly, the Markdown for every one of those documents holds **more** non-whitespace than the raw
> text (ratios 1.10–1.94), and content-token recall across the archive has a **median of 94.7%**.
> No content loss was demonstrated in any of them. The two fixes below are still correct — a chunk
> exceeding its budget is a real bug, and `done_reason: 'length'` has since fired three times in
> production and been caught — but they fixed a latent hazard, not the observed symptom that
> prompted them.

Two fixes, because either alone leaves a hole:

- `chunkText` now splits a line longer than the budget, preferring a whitespace boundary so words
  stay intact and hard-cutting only an unbroken run with no spaces (exceeding the budget is worse
  than an ugly seam). Re-chunking that same document: **380 chunks, 0 oversized, largest 1,277
  chars** — previously 228 chunks with the largest at 13,860.
- `requestTextChatCompletion` now returns ollama's `done_reason`, which it was discarding. Step C
  treats `'length'` — generation stopped at `num_predict`, not because the model finished — as a
  fallback rather than a conversion, keeping the raw chunk and logging a `WARN`. The raw text is
  worse-formatted but complete, and completeness is Step C's actual contract.

### A port clash killed the whole MCP server, stdio included

`startMcpHttpTransport` called `app.listen()` with no `'error'` listener. The HTTP transport is a
secondary surface — stdio has already connected by the time it runs — and `npm run mcp` is spawned
once per client, so two clients (Claude Desktop + Claude Code), or a single stale process, both bind
`MCP_HTTP_PORT` 3972. Node turns an unlistened `EADDRINUSE` into an uncaught exception, so the
second client's process died and took its healthy stdio transport with it. It now logs and degrades
to stdio-only, naming `MCP_HTTP_PORT` as the way out. Verified by squatting on 3972 and starting the
server: previously fatal, now `continuing with stdio only` and stdio stays connected.

### Repair registry would have misfiled a third of the archive

`findCanonicalCategoryForSubcategory` (`src/domain/taxonomy.ts`) returned the first category
containing a subcategory slug **by array position**. Subcategories are namespaced per-category, so
the same slug legitimately lives under several — the live taxonomy has **42 such slugs** out of 224
(`clinic_x` under contracts/health/bulletin_salaire, `pole_emploi` under four, `france_travail`
under seven). `repair-registry.ts` treats a differing answer as proof the document is misfiled: it
overwrites the DB row and hands the new category to `relocalizeFileIfNeeded`, which **physically
moves the file**.

Measured against the live registry: clicking Repair would have relocated **87 of 276 documents
(31.5%)** into a category nobody chose — every `clinic_x` payslip out of `bulletin_salaire` into
`contracts`, `permis_conduire` out of `identity` into `administrative`. Nothing was wrong with those
documents; JSON array order was deciding.

The lookup now collects *all* owning categories and refuses to guess: it returns the document's
current category when that is among the candidates (classification's choice beats array order), the
single owner when there is exactly one, and `null` — meaning "leave it alone" — when a slug is
ambiguous and the document sits under none of its owners. Unambiguous corrections still happen.
Re-measured after the fix: **0 of 276** documents would be moved. The function had no test coverage
at all; it now has seven cases, including the ambiguity ones.

### Step C deleted chunks it claimed to keep, and `npm test` wrote into the production log

An audit of the live registry (265 archived documents) against the code found four defects. All are
fixed, each with regression tests; the archive's *file moves* were verified clean — 0/258 documents
missing on disk, 0 path/taxonomy mismatches, 0 files outside `__archive`, 0 missing year segment.

- **A failed Markdown chunk was silently deleted, not kept.** `convertRawTextToZeroLossMarkdown`'s
  `catch` branch incremented `fallbackCount` and logged "keeping raw text chunk" while never pushing
  the chunk — so a chunk whose Ollama call threw vanished from `markdown_content` with no error
  reaching the caller. Reproduced directly: a 4-chunk document came back as chunks 1, 3, 4. Both
  fallback branches now keep the raw chunk and log at `WARN` with `chunkIndex`/`totalChunks`,
  instead of a `DEBUG` line nobody greps.

  This defect is **latent, not observed**: `conversion failed` has never appeared in the log. An
  earlier revision of this entry blamed it for six France Travail / Pôle Emploi documents whose
  `markdown_content` is a small fraction of their `raw_text` by length. That attribution was wrong
  twice over — those documents show no demonstrable content loss at all, and the length ratio that
  flagged them is a whitespace artefact (see the correction under "A chunk could exceed its own
  budget"). The `catch` branch was still a real bug worth closing before it fires; it simply has not
  fired.
- **The test suite appended to `logs/triage_debug.log`.** `logger.ts` writes to disk
  unconditionally and no suite mocked it, so every `npm test` added a measured **186 lines** of
  temp-dir paths and synthetic failures ("vision model unreachable", "canvas encode failed") to the
  real log — 380 of its 425 ERROR lines, and ~25% of the whole file, were test fixtures
  indistinguishable from genuine pipeline errors. `logger.ts` now honours a `PDF_TRIAGE_LOG_DIR`
  override and `vitest.setup.ts` points it at a temp directory. Measured after the fix: 0 lines.
  (`PDF_TRIAGE_DATA_DIR` was not usable — several suites deliberately assert on `DATA_DIR` falling
  back to `BASE_DIR` the way a git checkout does.)
- **The log had no rotation and only ever grew** — 12.8 MB / 45k lines, with no cap in the packaged
  desktop app either. `writeToFile` now rotates at `PDF_TRIAGE_LOG_MAX_BYTES` (default 5 MB),
  keeping `PDF_TRIAGE_LOG_RETAIN` generations (default 3); `0` disables rotation. A failed rotation
  still writes the line rather than throwing out of `logger.info()`. `logger.ts` had **no test file
  at all**, which is how all three of its defects survived; it has one now.
- **Entity matching rebuilt ~2,700 regexes on every call.** `matchEntityDictionary` constructed a
  `RegExp` per entity name and alias across all 1,044 dictionary entries, each with a Unicode
  lookbehind that V8 compiles on first execution: **2,092 ms** for the first full-dictionary call
  versus 23 ms against an empty one. Later calls only looked cheap because V8's evictable regex
  compilation cache still held the sources. A lowercase `includes()` pre-filter now rejects
  candidates whose literal text is absent (a boundary-anchored pattern cannot match without it), and
  the survivors are compiled once and memoized per dictionary object via a `WeakMap`. First call
  **2,092 ms → 19 ms**; `resolveSubcategory`'s ungrounded path **1,970 ms → 40 ms**. This also fixed
  a genuinely flaky test — `classification-resolution.test.ts` was timing out against vitest's 5 s
  limit — by removing the cost rather than raising the timeout. The suite runs ~2× faster (13 s → 7.5 s).
- **`getEntityDictionary()` re-read and re-validated 145 KB on every call.** It now caches on
  path + mtime + size, so an edit made while the server runs is still picked up on the next call
  (~6.7 ms → ~0.02 ms). A malformed file is deliberately never cached, so a half-written save
  retries instead of serving an empty dictionary for the process's lifetime. The existence probe
  stays `fs.existsSync`: several suites auto-mock `fs` and stub only `existsSync`/`readFileSync`,
  and probing with `statSync` instead made them yield an empty dictionary, flipping a real
  classification assertion (a France Travail payslip resolved to `employeur`).

### Scanned documents were extracted three pages deep, or not at all

The same audit found three silent truncations upstream of everything above — a document's text can
be missing from the registry, the classifier, the Markdown *and* the search index without a single
line in the log saying so. Measured against the 274 archived PDFs.

- **Canvas OCR rendered only the first 3 pages of any scanned PDF.** `ocrPdfPagesWithCanvas`
  defaulted to `maxPages = 3` and `extractPDFContent` called it with no argument, so a 19-page
  scanned insurance policy (`assuranceB20200315.pdf`) contributed 3 pages and the other 16 were
  dropped — with **no log line at all**. 13 archived documents were OCR'd while being longer than
  3 pages. The cap is now `CONFIG.OCR_MAX_PAGES` (env `OCR_MAX_PAGES`, default 10) and truncation
  always logs a `WARN` naming the skipped page range. Raising it costs one OCR round-trip per extra
  page, so it stays a deliberate quality/throughput knob rather than being unbounded.
- **The pdfjs recovery parser discarded everything past page 10** (`Math.min(doc.numPages, 10)`,
  also unlogged). 10 archived documents are longer than that. Pure text extraction costs
  milliseconds per page, so the ceiling is now 200 — a runaway guard, not a trade-off — and it warns
  when it bites.
- **A scanner watermark counted as a usable text layer, so OCR never ran.** The gate asked only
  whether the text was empty or under 10 characters. `attestation_emploi_GLOBEX_<user>.pdf`
  is an 8-page scan whose entire `raw_text` is `"Scanned with AnyScanner"` repeated 8 times — 198
  characters, 25 per page — so it passed the gate, never reached OCR, and **none of its actual
  content is in the registry**. New pure-domain `detectThinTextLayer()` (`src/domain/pdf-text.ts`)
  adds two symptoms as extra OCR triggers, both requiring ≥2 pages: density below 100 chars/page,
  and a text layer made of ≤2 distinct lines totalling ≤200 chars (a watermark). Single-page
  documents are deliberately exempt — a sparse certificate is legitimate — and the boilerplate rule
  requires the repeated content to be *short*, so a contract that repeats a long clause on every
  page is not dragged through OCR. Re-checked after the pdfjs tier too, since pdfjs reads the same
  text layer and usually recovers the same watermark. Validated against the live archive: of 274
  documents it flags exactly 2, both genuine, and no false positives. If OCR still cannot beat the
  watermark the thin text is kept rather than blanked, so the file archives instead of being
  stranded in `__raws`.

  Code review caught that the density half of that rule lacked the guard its boilerplate sibling
  has, so it would fire on a document that is merely SHORT — costing a pdfjs pass plus up to
  `OCR_MAX_PAGES` OCR round-trips to re-derive text already in hand. Density now also requires the
  text to be vocabulary-poor (`<10` distinct words per page): an un-extracted scan leaks only page
  furniture, so its few characters are also the same few words. Measured across the archive, the two
  starved documents carry 0.4 and 4.8 distinct words per page while normal multi-page documents sit
  at a 5th-percentile of 18.9. Re-validated after the change: still exactly those 2 flagged, now out
  of 457 documents.
- **`npm test` was nondeterministically red.** Roughly one run in three failed with "Test timed out
  in 5000ms" on whichever test happened to be the first `await import()` in its file
  (`triage-scan-duplicate-collision.test.ts:102`, `paddleocr-client.test.ts:353`,
  `mcp-server.test.ts:93`) — all three pass every time in isolation, and one of them only calls a
  pure function, so the time was going into pulling in pdfjs-dist / canvas / tesseract / sqlite3
  while every worker did the same at once (~50s cumulative import for a ~10s run). `testTimeout`
  and `hookTimeout` raised to 20s, which keeps a genuinely hung test failing while leaving room for
  a cold import under load. Verified green 5 runs in a row.

Docs corrected in the same pass, each against the code that contradicted them: Golden Rule #5 and
`triage-pipeline.md` step 8 said auto-created taxonomy entries go into the committed
`categories.json` (`categories-store.ts` writes only `.categories.private.json`);
`classification-flow.md` filed bank statements under `administrative` (both code paths emit `bank`,
and the archive is `bank/bnp_paribas` on disk); and `ollama-qwen.md` had **no description of Step C
at all** — it now documents the chunking, the continuation-context mechanism and its limits, and
both fallback paths.

### Rescan / Re-analyze could come back worse than the original triage

A re-analysis of an already-archived document rebuilt its title, date, summary and markdown from
*worse* text than the record already held, and moved the file into the wrong year folder. Three
independent defects stacked; all three are fixed.

- **PaddleOCR 500'd under concurrency.** `paddleocr_engine.py` shares one module-global `PaddleOCR`
  predictor, which is not thread-safe, while `main.py`'s endpoints are sync `def` and so run in
  Starlette's threadpool. Two overlapping `/ocr` requests — the 10s auto-watcher mid-scan while the
  user clicked Rescan — reached `predict()` together, raised, and returned HTTP 500. Inference is
  now serialized behind a `threading.RLock` **per model** (not one global lock, so a ~2s orientation
  probe never queues behind a multi-minute OCR pass).
- **A transient 5xx dropped the page straight to Tesseract.** `paddleOcrRecognize` now retries a
  5xx once after 1.5s before giving up the better engine. 4xx is not retried, and neither is a
  timeout (`OCR_TIMEOUT_MS` is already 300s). The fallback also logs at `warn` instead of `debug` —
  a silent quality downgrade left exactly one DEBUG line in an 11 MB log.
- **The re-analysis guard was a liveness check, not a quality one.** `reclassifyAndRelocalizeDocument`
  accepted any re-extraction over 10 chars, so 346 chars of OCR noise replaced 433 chars of clean
  text. `extractPDFContent` now reports `ocr_degraded` (tracked per page — a two-page scan can come
  back half PaddleOCR, half Tesseract), and a degraded re-extraction no longer overwrites usable
  stored text. Degraded text is still accepted when there is no stored text to protect.
- **`npm run dev` now restarts the PaddleOCR sidecar.** The lock above lives in a separate Python
  process that outlives a dev-server restart, and a stale one answers `/health` fine — so
  `ensurePaddleOcrServer()` reused it and the fix would never have loaded without hunting down the
  PID by hand. `startWebServer` now awaits `takeOverPaddleOcrServer()`, which kills the loopback
  service and clears both the readiness memo and the once-per-process spawn latch so the next OCR
  call spawns current code. A non-loopback `PADDLEOCR_HOST` is left strictly alone.
- **The record no longer contradicts itself.** `updateDocumentRecord` rewrote everything derived
  from the new text but left `raw_text` at the old value. The text a re-analysis actually used is
  now persisted alongside the conclusion it produced.

### `npm test` was destroying the real manual-decisions feedback log

Found while verifying the work above: the test suite ran against production data paths and wiped the
user's actual feedback log — the input to the feedback-teaches-AI loop (Golden Rule #18) — on every
run. On this machine the production `manual_decisions` table had been reduced to a single row, and
that row was a test fixture. Three defects, all fixed.

- **`manual-decisions-store.test.ts` used the real `CONFIG`.** It wrote `[]` over the real
  `manual_decisions.json` and ran `DELETE FROM manual_decisions` against the real `pdf_triage.db` in
  `beforeEach`. It now uses the same whole-module `settings.js` mock the other I/O suites use, so
  everything happens inside a temp directory.
- **`relocalize-document.test.ts` leaked writes into the repo root.** Its settings mock had no
  `MANUAL_DECISIONS_FILE`, and `reclassifyAndRelocalizeDocument()` calls `recordManualDecision()`,
  which is not mocked there — so its fixtures were appended to the real file. Added the key.
- **The store's fallback path was relative.** `CONFIG.MANUAL_DECISIONS_FILE || 'manual_decisions.json'`
  resolves against `process.cwd()`, which is what turned an incomplete CONFIG into a silent write to
  the repo root. It now requires an absolute configured path and throws otherwise; both call sites
  already catch and log, so a misconfiguration degrades to a logged error instead of a write landing
  where nobody looks.

This was also the cause of the intermittent suite failures (`expected 3 to be 1`) that looked like
machine load: two suites running in parallel workers were corrupting one shared file. The suite now
runs **649/649 green**, and `manual_decisions.json` and the DB are byte-identical before and after.

### Corrected the documented system requirements — they understated the real ones

The README's requirements tables were wrong in ways that would have let someone build a machine the
app cannot run properly. Every figure below is now measured on a live install rather than estimated.

- **VRAM: 6 GB → 8 GB.** `qwen3.5:9b` is **6.6 GB** resident at the `num_ctx: 16384` the app uses.
  Measured on an RTX 3060 Ti (8 GB): it loads at 100% GPU with 582 MB to spare. A 6 GB card cannot
  hold it — Ollama offloads layers to CPU and classification slows by roughly an order of magnitude.
- **Model size: 5.5 GB → 6.6 GB**, and the storage breakdown was missing the vision model (1.6 GB),
  `node_modules` (0.9 GB), the Python OCR deps (0.5 GB) and the PaddleOCR model cache (0.2 GB).
  A full install is **≈9.8 GB** before a single document is archived, plus **≈158 KB per document**
  in SQLite (measured across 139 documents).
- **Minimum RAM: 8 GB → 16 GB** for the CPU-only path. Without a GPU the 6.6 GB of weights sit in
  system RAM on top of ~1.5 GB of app processes; 8 GB does not fit that.
- **Removed a tip that could not work.** The README suggested dropping to `qwen2.5:3b`/`7b` via
  `ollama_model` in `settings.json` to fit a smaller machine. That setting is *silently ignored* —
  `sanitizeOllamaModel()` warns and forces `qwen3.5:9b` back, per Golden Rule #14.
- **Documented what the GPU does not do.** OCR runs on CPU (`paddlepaddle` is the CPU build) and is
  the throughput bottleneck: measured **58 documents in 119 minutes**, split 30-60s for a digital
  text layer (GPU-bound) versus 120-230s when OCR is needed (CPU-bound).
- **`ollama pull minicpm-v4.6`** was never in the prerequisites despite the photo pipeline using it;
  now listed as optional, with the fallbacks it degrades to spelled out.

Docs: [README → System Requirements](README.md#-system-requirements),
[environment → Resource requirements](docs/knowledge/environment.md#resource-requirements).

### The OCR timeout budget now measures inference, and nothing else

Successful PaddleOCR passes were measured at 100-230s against a flat 300s budget. Anything else
charged to that budget tipped a page into the Tesseract fallback — and a fallback is a silent
quality loss, not just a slower result.

- **Model loading no longer counts.** `/health` answers the instant the process is up (deliberately —
  the client's ~15s spawn poll depends on it) while the models are still warming behind it. That is
  why the auto-restart added above cost a document its PaddleOCR pass: the process was spawned one
  second into the request and the whole 300s went on loading. `paddleocr-server` now exposes
  **`GET /ready`** (`{ready, ocr, orientation, warming}`), read lock-free so it still answers during
  a running OCR pass, and `paddleOcrRecognize` waits on it under a separate 15-minute budget before
  the inference timer starts. A failed warm-up reports `warming: false`, and a server with no
  `/ready` is treated the same way — both mean "proceed", never "block forever".
- **Queue time no longer counts.** `runExclusive()` serializes this process's inference calls and the
  abort signal is created as the request goes out, not when it was queued. One request waiting
  behind another was on its own enough to blow the old budget. The server's per-model lock remains
  the correctness backstop; this keeps the client's timer honest about what it measures.
- **The budget scales with the page.** `ocrTimeoutFor()` reads the render's real geometry through the
  new pure `domain/image-dimensions.ts` (PNG/JPEG header read, no decode) and scales linearly
  against a 2.0 MP reference — twice the area, twice the budget. Floor 300s, cap 20 min so a wedged
  server cannot stall a scan indefinitely. Unreadable geometry falls back to the floor rather than
  guessing from byte length, which is a poor proxy for OCR time.

Docs: [architecture — OCR engine fallback and its cost](docs/knowledge/architecture.md#ocr-engine-fallback-and-its-cost),
[relocalize — which text a re-analysis uses](docs/workflows/relocalize.md#which-text-a-re-analysis-uses).

### Publishability — the repo is now safe to make public

- **Personal data split out of `prompts/`.** Every committed prompt template is generic. The real
  employers, bank statement filename codes, scanner prefixes, clinics and schools moved to a
  gitignored `.prompts.private.json` (template: `prompts.private.json.example`), rendered into two
  placeholders — `{{USER_PRIORITY_RULES}}` (a STEP 0 block ahead of the generic STEP 1..13 flow)
  and `{{USER_KNOWN_ENTITIES}}` (Step A entity extraction). See
  [taxonomy](docs/knowledge/taxonomy.md#personal-prompt-overlay).
- **The same overlay drives the offline classifier.** `ruleBasedClassify` had the *same* personal
  entities hardcoded in its regexes; they now come from that one file via `matchPriorityRules()`.
  One source for both paths is what keeps the prompt and the fallback aligned instead of silently
  drifting. A non-bank overlay rule never outranks a bank statement (Golden Rule #6), in both paths.
- **Real personal data removed from test fixtures.** `pdf-text.test.ts` held a verbatim month of a
  real bank ledger (salary line, transfer references, counterparty account + BIC), a Luhn-valid
  employer SIREN/SIRET, and a second fixture with a home address and employer. Those fixtures assert
  only *structural* properties, so every value is now synthetic. Also scrubbed: family names used as
  denylist fixtures, the bank branch token, an owner surname in a code comment, and workspace paths
  containing the OS username.
- **Git history purged.** `settings.json` (OneDrive personal document paths) was committed in the
  original root commit, which survived in two local branches. `origin/main` was never affected. Both
  branches deleted, reflog expired, `gc --prune=now` — the object no longer exists — and
  `remote.origin.push` pinned to `refs/heads/main`.
- **Licensing fixed.** `package.json` declared ISC against an MIT `LICENSE`; author and repository
  were empty. The vendored obra/superpowers tree was also committed **twice** (100 files, via the
  `docs/skills` and `.claude/skills` directory junctions) without its upstream MIT notice — both are
  now untracked and gitignored; the junctions still work locally.
- **Regression guard.** `src/domain/prompt-hygiene.test.ts` scans the whole committed tree
  (`src/`, `prompts/`, `public/`, `docs/`, root config) against `CONFIG.PERSONAL_NAME_DENYLIST` and
  reports only file paths, never the matched token, so the failure output stays publishable itself.

### Security

- **Path traversal closed in `computeCanonicalPath()`.** `category` and `subcategory` reached
  `path.join` unvalidated from `POST /api/documents/:id/relocalize` (which has no schema) and from
  MCP tool calls. Three payloads escaped `OUTPUT_ROOT_DIR`, one resolving into `C:/Windows/System32`.
  Every segment is now sanitized in the domain, so triage, relocalize and MCP are all covered at
  once; legitimate slugs and multi-level nesting are byte-identical.
- **Arbitrary file read closed in `/api/pdf/merge` and `/api/pdf/split`.** Both took an absolute path
  from the request body with only an `existsSync` check, then wrote a derivative into `__raws` where
  the watcher archives it into the searchable registry. Both now resolve through a shared
  `resolveManagedPath()`; `GET /api/documents/file-by-path` reuses it.
- **`Access-Control-Allow-Origin: '*'` removed from `/api/logs/stream`.** It contradicted the
  documented no-CORS decision ~390 lines above it and exposed original filenames, resolved entity
  categories and decision traces to any page open in another tab.

### Fixed

- **FTS5 had been dead for the life of the database.** `CREATE VIRTUAL TABLE IF NOT EXISTS` cannot
  migrate an existing table, so the on-disk table kept 7 columns while the INSERTs grew to 11; every
  insert failed at prepare into an empty `catch`, leaving **0 indexed rows against 336 documents**.
  `initSchema()` now detects column drift, rebuilds, and backfills; write failures warn once instead
  of vanishing.
- **Image→PDF conversion could destroy an unrelated PDF.** The target name came from the image's
  stem with no existence check, so `contrat.jpg` + `contrat.pdf` in one batch replaced the signed
  contract's bytes with a photo, unrecoverably. The name is now claimed with the `wx` flag
  (exclusive create) and falls back to a suffix.
- **Two scans could interleave over the same files.** `POST /api/triage/unlock` cleared the re-entry
  guard without cancelling the running loop, and the lock file could not see same-process re-entry.
  Now: `acquireScanLock()` tracks in-process ownership and its release is idempotent, and
  `runTriageScan` polls an abort flag per file so Stop actually stops.
- **Golden Rule #4 guard caught 3 of ~20 sentinels.** `triage-scan.ts` used an inline
  `general/other/divers` test while `resolveSubcategory` deliberately returns `unknown`,
  `camscanner`, year strings and file extensions *for that guard to block*. It now uses the canonical
  `isForbiddenSubcategory()`, as every other write path already did.
- **Eight classifier branch-shadowing bugs**, each reproduced before fixing and now pinned by tests:
  a fines row inside a bank statement pulled the whole statement to `administrative/amende`
  (the archetypal Golden Rule #6 trap, in the one branch that sat above the guard); `cni` matched
  inside `CNIL` boilerplate; bare `visa` claimed any card receipt; `/\bbus|navigo\b/` and five
  sibling regexes were mis-scoped alternations, so "Business Center" became a transport pass; bare
  `stage` filed CDIs as internships; bare `dossier` and English "free" minted junk subcategories;
  and `preprocessRawText` split ordinary words (`private` → `pri vate`) in the very text the
  classifier reads.
- **Six metadata fields rejected an explicit JSON `null`.** A single `"registre": null` from Qwen
  threw the whole Step A/C/D result away and downgraded the document to the rule-based fallback.
- **Typecheck is clean again** (was 3 pre-existing errors in test fixtures).

### Changed

- **Converted source photos are kept, not deleted.** They move to
  `__raws/.delete_files/img_converted/` — the archived PDF holds a cropped, re-encoded rendition, so
  a mis-detected crop is only recoverable from the original. Nothing prunes that folder.
- **A folder of photos in `__raws` becomes ONE multi-page PDF.** `__raws/contrat-bail/` with three
  photos produces `contrat-bail.pdf` with three pages, ordered numerically (`IMG_2` before `IMG_10`)
  with each page's OCR text concatenated. Qualifies only on 2+ images and no other file type — a
  lone photo, or a folder you also keep a PDF in, is triaged file by file as before.
- **The classification prompt fits in the context window again.** `buildEntityHintLine` dumped all
  ~1,000 dictionary entities into every prompt for every category: 44,873 of 50,859 chars (88%),
  pushing the system prompt to ~19,300 tokens against the pinned `num_ctx` of 8192 — more than half
  of it, including the tail of the decision flow, discarded before the model read a word. Entity
  hints are now filtered to entities the document actually mentions: ~6,500 tokens, and it fits.
  This is a correctness fix before it is a speed one.

### Build

- **`npm run build` now cleans `dist/` first.** `tsc` never prunes output for deleted sources and
  `build.files` ships `dist/**/*`, so the 22 orphaned `.js` files left by the removal below —
  including the hazardous `TriageScanUseCase.js` — would have been packaged into the `.exe`.
  Also added `prompts.private.json.example` to the packaged files, so a portable-exe user can
  discover the private prompt overlay at all (there is no UI for it).

### Removed

- **865 lines of unwired DDD scaffolding** (`domain/model/`, `domain/repositories/`,
  `application/use-cases/`, `infrastructure/adapters/`, `infrastructure/http/controllers/`,
  `infrastructure/di/`) — 22 files, imported by nothing, type-checked and compiled on every build.
  `TriageScanUseCase.ts` was the real hazard: the cleanest-looking scan pipeline in the repo, and it
  violated five Golden Rules, had no image branch, and moved files to `__archive` before the DB row
  existed. The wired three-layer design plus parameter-injected, unit-tested domain functions is the
  architecture; CLAUDE.md now records that a DI container, aggregate classes, a domain-event bus, a
  unit of work and a command/query dispatcher are explicitly **not** wanted here.


### Added (earlier, same Unreleased cycle)

- **MCP server now reachable over HTTP, not just stdio** — `npm run mcp` starts a Streamable
  HTTP transport (`POST /mcp`, default port `3972`, `CONFIG.MCP_HTTP_PORT`/`MCP_HTTP_HOST`)
  alongside the existing stdio transport, both sharing the same tool handlers
  (`src/infrastructure/mcp/mcp-server.ts`). This lets agents that can't spawn a local process
  — OpenAI Agents SDK, another machine on the LAN — call the same tools Claude Desktop/Code
  already use via stdio. Defaults to LAN-reachable (`0.0.0.0`) per explicit choice (documents
  are personal, so this is guarded by a required `Authorization: Bearer <token>` instead of by
  binding — token auto-generated into the gitignored `.mcp-api-token` on first start, printed
  to console; wrong/missing token → 401, checked with `crypto.timingSafeEqual`). Stateless
  design: every HTTP request gets a fresh `Server` + `StreamableHTTPServerTransport` pair, no
  session state to manage. Verified end-to-end: 401 on missing/wrong token, `initialize` +
  `tools/list` + a real `search_documents` call, all round-tripped correctly over curl.
  Also added the **`package_documents`** MCP tool — builds a real `.zip` of resolved documents
  (explicit `docIds` or a `dossierType` free-text query, same resolution `prepare_dossier`
  uses) under `__packages/`, reusing the existing `zip-builder.ts` used by the web UI's
  package-zip export; returns the zip path plus which requested docs had no file on disk.
  Verified with a real 2-document package (valid zip header, correct file count). See
  `docs/knowledge/api-reference.md` (MCP tools section) and `docs/agents/mcp-integrator.md`.
- **Grand Viewer stuck-placeholder fix** — `openGrandViewerModal()`
  (`public/ts/ModalsManager.ts`) left the "Fetching full document text from
  server..." placeholder on screen forever if anything threw after the fetch
  succeeded (its `catch` block only toasted an error, never touched the
  placeholder). Now resets the text area to an explicit `⚠️ Failed to load
  document text: ...` message on that path. Investigated after a user report
  of "many" documents appearing stuck; could not reproduce against the live
  corpus (all 313 documents load cleanly), but the gap was real and matched
  the reported symptom exactly, so it's fixed defensively. Not yet committed.
- **Full-corpus markdown table re-check** — an ad hoc script
  (`scratch/monitor-and-repair-tables.mts`) is walking the ~888-document
  corpus, re-running `convertRawTextToZeroLossMarkdown()` on every document
  whose `markdown_content` still has a garbled table, as the live auto-watcher
  reprocesses the corpus after the two fixes below. One-off tooling, not part
  of the shipped app.

## 2026-08-24 — Markdown/classification correctness fixes

- **`fix(classification): accept explicit null on optional metadata string fields`**
  ([f6854d2](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/f6854d2)) — Qwen frequently returns JSON `null`
  (not an absent key) for a field that doesn't apply to a document
  (`expiry_date` on a bank statement, `iban` on a payslip, etc.).
  `z.string().optional()` only tolerates `undefined`, so an explicit `null`
  threw out of `DocumentMetadataSchema.parse()`, and `classify-document.ts`'s
  catch block silently downgraded the whole document to the generic
  rule-based fallback classifier — usually landing it in `.blocked_files`
  instead of being properly filed. Fixed with a
  `z.string().nullable().optional().transform(v => v ?? "")` helper applied
  to all 10 affected fields in `src/domain/document.schema.ts`.
- **`fix(classification): avoid fabricating label-value pairs in scrambled OCR tables`**
  ([53966cc](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/53966cc)) — added rule 2b to
  `prompts/micro_prompt_markdown.md`: when OCR reading-order scrambles a
  table's rows/columns, Qwen was pattern-matching plausible-looking
  label/value pairs instead of preserving what the raw text actually says.
  Measurable improvement, not a full fix — some source documents have
  genuinely lost row/column correspondence in the OCR text itself and are
  unrecoverable at the markdown layer.

## 2026-08-24 — Dev-server port takeover

- **`feat(dev-server): auto-recover from a stale process on the port`**
  ([7bc162b](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/7bc162b)) — `npm run dev` / `npm run vision:dev`
  now auto-detect and kill whatever holds the target port before retrying,
  once, instead of failing with `EADDRINUSE`. Added `killProcessOnPort(port)`
  to `src/infrastructure/pid-lock.ts` (Windows `netstat -ano -p tcp` +
  `taskkill /PID <pid> /F`); `startWebServer`/`startVisionLabServer`
  refactored into an `attemptListen(port, allowTakeover)` retry pattern.
  Root cause of the fix: a worktree-launched dev server instance was left
  running and silently squatting on the main port, so every later
  `npm run dev` from `main` failed to start while the user was unknowingly
  looking at the stale instance's near-empty dashboard — this looked like
  "lost all my documents" but no data was ever touched. See
  `docs/superpowers/specs/2026-08-24-dev-server-port-takeover-design.md`
  and the "Server startup and port takeover" section of
  `docs/knowledge/architecture.md`.
- **`docs: document port-takeover mechanism and add a document-flow diagram`**
  ([8fff030](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/8fff030)) — added the Mermaid triage-pipeline
  flowchart now in `docs/knowledge/architecture.md`.

## 2026-08-23 — Photo → PDF triage + PaddleOCR-first, merged from `vision-lab-image-to-pdf`

- **`feat(triage): convert incoming photos to archivable PDFs with vision preprocessing`**
  ([a334e69](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/a334e69)) — incoming photos
  (`.jpg/.png/.webp/.bmp/.tiff`) are no longer archived as raw images: they
  run through the vision pipeline (orient → crop → enhance → OCR) and are
  filed as single-page A4 PDFs. See `src/application/convert-image-document.ts`.
  Golden rule: the source image is never deleted before its PDF is on disk —
  conversion is an enhancement, never a gate; if it fails, the photo is
  triaged as-is rather than blocking a readable document.
- **`fix(vision-lab): correct document crop, orientation and OCR timeouts`**
  ([6a5ef60](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/6a5ef60)).
- Merge commit **`Merge vision-lab: photo→PDF triage, crop/orientation fixes, PaddleOCR-first OCR`**
  ([9878cbc](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/9878cbc)) folded the `vision-lab-image-to-pdf`
  worktree's full history (PaddleOCR integration + Vision Lab step redesign,
  both detailed below) into `main`, followed by a docs correction pass
  ([179bc67](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/179bc67)).

## 2026-08-15 — Vision Lab: step-by-step diagnostic redesign

Replaced the old batch `runVisionPipeline` diagnostic pipeline with 4
independently callable step functions (orient / crop / enhance / extract)
behind a single `POST /api/vision/diagnose-step` endpoint, plus a "Next"
button UI with per-step compare-candidate selectors on
`public/test-image-to-pdf.html` (purely visual — doesn't affect pipeline
flow).

- `feat(vision-lab): replace runVisionPipeline with 4 independently callable step functions` ([91eec9f](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/91eec9f))
- `feat(vision-lab): replace batch diagnose-image endpoint with per-step diagnose-step endpoint` ([7dc927d](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/7dc927d))
- `feat(vision-lab): add ocrImageBufferBothEngines for side-by-side OCR comparison` ([a18f2c4](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/a18f2c4))
- `feat(vision-lab): add Next-button step-by-step navigation with compare selectors` ([f902450](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/f902450))
- Design: `docs(specs): redesign Vision Lab extract-text as step-by-step with compare views` ([c6d7cb7](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/c6d7cb7))

## 2026-08-15 — PaddleOCR integration (replaces Tesseract.js as primary OCR)

Local PaddleOCR HTTP microservice (`paddleocr-server/`, FastAPI) is now tried
first everywhere OCR happens; Tesseract.js is kept only as an availability
fallback (not run redundantly as a quality cascade).

- `feat(paddleocr): add standalone PaddleOCR HTTP service` ([4a88924](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/4a88924))
- `feat(paddleocr): add Node HTTP client with auto-spawn` ([0a91054](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/0a91054)) — `src/infrastructure/paddleocr-client.ts`
- `feat(paddleocr): use PaddleOCR for scanned-PDF OCR, Tesseract as fallback` ([892d276](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/892d276))
- `feat(paddleocr): use PaddleOCR for standalone image-file OCR, Tesseract as fallback` ([d816993](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/d816993))
- `feat(paddleocr): use PaddleOCR for orientation tiebreaker, Tesseract OSD as fallback` ([f4136d5](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/f4136d5))
- `fix(paddleocr): satisfy Blob typing for Node Buffer in FormData uploads` ([5d11756](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/5d11756)) — `new Blob([buf])` isn't assignable to `BlobPart` for a Node `Buffer`; fixed with `new Blob([new Uint8Array(buf)])`.
- `fix(paddleocr): avoid repeated spawn penalty, add fetch timeouts, fail closed on malformed OCR response` ([bd6ae31](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/bd6ae31)) — `ensurePaddleOcrServer()` separates "have we attempted the exec+poll sequence once" from "is it currently reachable" via a `spawnAttempted` flag.
- `fix(paddleocr): log PaddleOCR fallback reason in orientation tiebreaker, fix stale comment` ([72a6e1f](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/72a6e1f))
- `fix(paddleocr): log full traceback on engine errors instead of dropping it` ([2acd0bf](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/2acd0bf))
- Design: `docs(specs): add PaddleOCR integration design (replace tesseract.js)` ([52958a6](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/52958a6))

## 2026-08-13 — Vision Lab origins

Standalone Vision Lab diagnostic server (`npm run vision:dev`, port 3179)
and its first-generation batch pipeline.

- `feat(vision-lab): add standalone Vision Lab server on port 3179` ([bda523d](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/bda523d))
- `feat(vision-lab): add runVisionPipeline orchestrator` ([2c2e4d0](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/2c2e4d0))
- `feat(vision-lab): add napi-rs/canvas rotate/crop/enhance image processor` ([21ff079](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/21ff079))
- `feat(vision-lab): add minicpm-v4.6 orientation and crop-box detection client` ([e116bd0](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/e116bd0))
- `feat(vision-lab): port auto-levels and sharpen math from pdf-awesome` ([6e1de66](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/6e1de66))
- `fix(vision-lab): add EXIF/OCR orientation cascade and pipeline logging` ([abab5cb](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/abab5cb))
- `fix(vision-lab): address 9 final-review findings` ([adc87b2](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/adc87b2))
- Design: `docs: add Image to PDF Vision Lab design spec` ([1389bb9](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/1389bb9))

## 2026-08-11 to 2026-08-12 — Initial hardening pass

- `cbe2abf` — Initial commit: Smart PDF Triage — local-first PDF triage & agentic registry.
- `fix(security): fix arbitrary file read, open CORS/network exposure, shell injection` ([f3add30](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/f3add30)).
- `fix(build): make dist:exe exit automatically instead of hanging after the build finishes` ([67c9a23](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/67c9a23)).
- `fix(desktop): resolve BASE_DIR from this file's location, not process.cwd()` ([8d009bb](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/8d009bb)).
- `fix(desktop): fix .env path resolution, bundle prompts/, enable native module rebuild` ([4668370](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/4668370)).
- `fix(ui): style the Group by Document Session cards (previously unstyled)` ([bcb2a91](https://github.com/phamhung075/smart-pdf-triage-local-ai/commit/bcb2a91)).
