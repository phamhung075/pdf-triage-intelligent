/**
 * One-shot migration: merge every duplicated subcategory to its single canonical category.
 *
 * Approved mapping (2026-08-27):
 *  - 16 subcategory slugs that appeared under several categories keep ONE canonical home.
 *  - `france_travail` top-level category removed; its docs/subcats fold into `administrative`.
 *  - Same-entity different-spelling slugs folded: laposte->la_poste, prefecture_bouches-du-rhone->prefecture,
 *    sarl_le_pacifique->pacifique4; plus one pay slip misfiled under bulletin_salaire/service_public
 *    re-filed to bulletin_salaire/pacifique4.
 *
 * Reuses the app's own machinery (computeCanonicalPath / relocalizeFileIfNeeded /
 * updateDocumentRecord / syncJSONRegistry) so the outcome is byte-identical to what the
 * app's Repair Registry would produce after the taxonomy fix.
 *
 * Usage:
 *   npx tsx scripts/merge-subcategories.ts --dry-run   # preview only, writes nothing
 *   npx tsx scripts/merge-subcategories.ts --apply     # executes DB updates + file moves
 */
import { reloadConfigFromDisk, ensureDirectoriesExist, CONFIG } from '../src/infrastructure/settings.js';
import { getCategoriesConfig } from '../src/infrastructure/categories-store.js';
import { getAllDocuments, updateDocumentRecord } from '../src/infrastructure/db/database.js';
import { findActualFileOnDisk, relocalizeFileIfNeeded } from '../src/application/relocalize-document.js';
import { syncJSONRegistry } from '../src/infrastructure/json-registry.js';
import { CategoriesConfigSchema } from '../src/domain/document.schema.js';
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify-only');

// slug -> canonical category id (approved mapping)
const CANONICAL: Record<string, string> = {
  alternance: 'education',
  amende: 'administrative',
  by_conseil: 'bulletin_salaire',
  caisse_des_depots: 'bank',
  cesi: 'education',
  dgfip: 'administrative',
  foncia: 'housing',
  france_travail: 'administrative',
  hopital_st_joseph: 'invoices',
  lai_dentail: 'bulletin_salaire',
  openclassrooms: 'education',
  pole_emploi: 'administrative',
  pro_electro: 'bulletin_salaire',
  service_public: 'administrative',
  tribunal_administratif_marseille: 'correspondence',
  urssaf: 'administrative',
  allocation: 'administrative',        // from removed france_travail category
  mes_candidatures: 'administrative',  // from removed france_travail category
};

// same entity, different slug -> target (slug, category)
const SLUG_RENAMES: Record<string, { slug: string; category: string }> = {
  laposte: { slug: 'la_poste', category: 'correspondence' },
  'prefecture_bouches-du-rhone': { slug: 'prefecture', category: 'administrative' },
  sarl_le_pacifique: { slug: 'pacifique4', category: 'bulletin_salaire' },
};

// doc-level misfile: a Le Pacifique pay slip sitting under bulletin_salaire/service_public
const SPECIAL_REFILES: Array<{ category: string; subcategory: string; toCategory: string; toSubcategory: string }> = [
  { category: 'bulletin_salaire', subcategory: 'service_public', toCategory: 'bulletin_salaire', toSubcategory: 'pacifique4' },
];

interface PlannedChange {
  id: number;
  title: string;
  from: string; // cat/sub
  to: string;   // cat/sub
  kind: 'canonical' | 'rename' | 'refile' | 'category-removed';
}

function planChanges(docs: any[]): PlannedChange[] {
  const changes: PlannedChange[] = [];
  for (const doc of docs) {
    const sub = (doc.subcategory || '').toLowerCase().trim();
    const cat = (doc.category || '').toLowerCase().trim();

    // slug renames first (highest precedence)
    const rename = SLUG_RENAMES[sub];
    if (rename) {
      if (!(rename.category === cat && rename.slug === sub)) {
        changes.push({ id: doc.id, title: doc.title, from: `${cat}/${sub}`, to: `${rename.category}/${rename.slug}`, kind: 'rename' });
      }
      continue;
    }

    // special misfile re-files
    const special = SPECIAL_REFILES.find(s => s.category === cat && s.subcategory === sub);
    if (special) {
      changes.push({ id: doc.id, title: doc.title, from: `${cat}/${sub}`, to: `${special.toCategory}/${special.toSubcategory}`, kind: 'refile' });
      continue;
    }

    // canonical category fix
    const canonical = CANONICAL[sub];
    if (canonical && canonical !== cat) {
      const kind = cat === 'france_travail' ? 'category-removed' : 'canonical';
      changes.push({ id: doc.id, title: doc.title, from: `${cat}/${sub}`, to: `${canonical}/${sub}`, kind });
    }
  }
  return changes;
}

async function main() {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  // 1) Validate the on-disk taxonomy with the app's own schema + one-instance invariant.
  const config = getCategoriesConfig();
  CategoriesConfigSchema.parse(config);
  const slugOwners = new Map<string, string[]>();
  for (const c of config.categories) {
    for (const s of c.subcategories || []) {
      const list = slugOwners.get(s.id) || [];
      list.push(c.id);
      slugOwners.set(s.id, list);
    }
  }
  const dups = [...slugOwners.entries()].filter(([, cats]) => cats.length > 1);
  if (dups.length > 0) {
    console.error('ABORT: taxonomy still has duplicated subcategories:', JSON.stringify(dups));
    process.exit(1);
  }
  if (config.categories.some(c => c.id === 'france_travail')) {
    console.error('ABORT: france_travail category still present in merged taxonomy');
    process.exit(1);
  }
  console.log(`Taxonomy OK: ${config.categories.length} categories, no duplicated subcategory slugs.`);

  // 2) Build the change plan from live DB rows.
  const docs = await getAllDocuments();
  const changes = planChanges(docs);
  const byKind: Record<string, number> = {};
  for (const c of changes) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  console.log(`\nPlanned changes: ${changes.length} document(s)`);
  console.log('  by kind:', JSON.stringify(byKind));
  if (changes.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }
  for (const c of changes) {
    console.log(`  ${c.kind.padEnd(16)} #${c.id}  ${(c.title || '').slice(0, 60).padEnd(62)} ${c.from}  ->  ${c.to}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to execute.');
    return;
  }

  // 3) Execute: update DB row + physically move the file (app's own relocalize logic).
  let movedCount = 0;
  let dbOnlyCount = 0;
  for (const c of changes) {
    const doc = docs.find(d => d.id === c.id)!;
    const [toCat, toSub] = c.to.split('/');
    const actualPath = findActualFileOnDisk(doc);
    let newPath = doc.new_path;
    if (actualPath && fs.existsSync(actualPath)) {
      const res = relocalizeFileIfNeeded(actualPath, toCat, toSub, doc.date, doc.title);
      newPath = res.newPath;
      if (res.moved) movedCount++;
    } else {
      dbOnlyCount++;
      console.warn(`  WARN #${c.id}: physical file missing for '${c.title}' — DB record updated only (new_path kept).`);
    }
    await updateDocumentRecord(c.id, { category: toCat, subcategory: toSub, new_path: newPath, status: 'MOVED' });
  }

  await syncJSONRegistry();
  console.log(`\nMigration complete: ${movedCount} file(s) physically moved, ${dbOnlyCount} DB-only update(s), registry.json regenerated.`);
}

if (VERIFY_ONLY) {
  // verification mode: recompute the plan against the DB after migration
  (async () => {
    reloadConfigFromDisk();
    const docs = await getAllDocuments();
    const changes = planChanges(docs);
    console.log(`VERIFY: remaining planned changes after migration = ${changes.length}`);
    for (const c of changes) console.log(`  ${c.kind} #${c.id} ${c.from} -> ${c.to}`);
    process.exit(changes.length === 0 ? 0 : 1);
  })();
} else {
  main().catch(err => { console.error(err); process.exit(1); });
}
