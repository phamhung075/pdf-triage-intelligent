import path from 'path';
import { logger } from '../infrastructure/logger.js';

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

export type DocumentFileType = 'PDF' | 'IMAGE' | 'TEXT' | 'WORD' | 'EXCEL';

export function detectFileType(filename?: string): DocumentFileType {
  if (!filename) return 'PDF';
  const ext = path.extname(filename).toLowerCase().trim();
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) return 'IMAGE';
  if (['.txt', '.md', '.csv', '.log', '.json'].includes(ext)) return 'TEXT';
  if (['.docx', '.doc'].includes(ext)) return 'WORD';
  if (['.xlsx', '.xls'].includes(ext)) return 'EXCEL';
  return 'PDF';
}

// Golden Rule #4: general/other/divers/empty/year-only are never valid final
// subcategories — any write path that lets a caller set an explicit subcategory
// must reject these, not just the initial classification flow.
const FORBIDDEN_SUBCATEGORIES = new Set([
  'general', 'other', 'divers', 'unknown', 'none',
  'anyscanner', 'camscanner', 'geniusscan', 'adobescan', 'tinyscanner', 'simplescan', 'docscanner',
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'pdf', 'txt', 'docx', 'xlsx'
]);

export function isForbiddenSubcategory(subcategory?: string): boolean {
  if (!subcategory) return true;
  const rawLower = subcategory.toLowerCase().trim();
  const normalized = rawLower.replace(/[^a-z0-9]+/g, '');
  if (normalized.length === 0) return true;
  if (FORBIDDEN_SUBCATEGORIES.has(rawLower) || FORBIDDEN_SUBCATEGORIES.has(normalized) || isYearString(rawLower)) return true;
  // Reject pure numeric or date-like slugs (e.g. "102818", "20260811")
  if (/^\d+$/.test(normalized)) return true;
  // Reject slugs ending in file extensions (e.g. "verso_png", "sinistre_docx", "102818_jpg", "img_123_png")
  if (/.*[._-](pdf|jpg|jpeg|png|webp|tiff|bmp|txt|docx|xlsx)$/i.test(rawLower)) return true;
  // Reject raw date / random number + file extension patterns (e.g. "102818jpg", "img123png")
  if (/^(\d+|img\d*|scan\d*|photo\d*|doc\d*|file\d*)[_.]?(pdf|jpg|jpeg|png|webp|tiff|bmp|txt|docx|xlsx)$/i.test(rawLower)) return true;
  // Reject scanner software names (e.g. "anyscanner", "camscanner", "geniusscan")
  if (/^(anyscanner|camscanner|geniusscan|adobescan|tinyscanner|simplescan|docscanner)/i.test(normalized)) return true;
  return false;
}

/**
 * The category a subcategory slug canonically belongs to, or `null` when that cannot be decided.
 *
 * `null` means "leave this document's category alone" — it is not an error. The caller
 * (repair-registry.ts) overwrites the DB row and physically relocates the file on a non-null
 * answer, so guessing here silently rewrites the archive.
 *
 * This used to return the first category containing the slug, by array position. Subcategories are
 * namespaced per-category, so the same slug legitimately appears under several of them — the live
 * taxonomy has 42 such slugs — and array order was deciding which one won. A Repair run would have
 * relocated 87 of 276 archived documents on that basis: every `clinic_x` payslip out of
 * `bulletin_salaire` into `contracts`, `permis_conduire` out of `identity` into `administrative`,
 * and so on. Order in a JSON file is not evidence about a document.
 *
 * @param currentCategory the document's existing category. When the slug is ambiguous and the
 *   document already sits under one of the candidates, that placement is the answer — it was chosen
 *   by classification (or by the user), which is strictly better information than array order.
 */
export function findCanonicalCategoryForSubcategory(
  subcategorySlug: string | undefined,
  categoriesConfig: any,
  currentCategory?: string
): string | null {
  if (!subcategorySlug || isForbiddenSubcategory(subcategorySlug)) return null;
  const subLower = subcategorySlug.toLowerCase().trim();

  const matches: string[] = [];
  for (const cat of categoriesConfig?.categories || []) {
    if (cat.subcategories && cat.subcategories.some((s: any) => s.id?.toLowerCase() === subLower)) {
      matches.push(cat.id);
    }
  }

  if (matches.length === 0) return null;

  // Already sitting under a category that legitimately owns this slug — nothing to correct.
  const current = currentCategory?.toLowerCase().trim();
  if (current && matches.some(m => m.toLowerCase() === current)) {
    return matches.find(m => m.toLowerCase() === current)!;
  }

  // Exactly one owner: an unambiguous correction, which is what this function is for.
  if (matches.length === 1) return matches[0];

  // Several owners and the document is under none of them. There is no evidence here for choosing
  // between them, so decline rather than move the file somewhere arbitrary.
  return null;
}

export function isGenericFilename(filename: string): boolean {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext).toLowerCase().trim();

  if (stem.length <= 3) return true;
  if (/^\d+$/.test(stem)) return true; // e.g. 98765432109876543210987
  if (/^[a-f0-9]{16,64}/i.test(stem)) return true; // Starts with MD5/SHA hash e.g. b3ecb7ae978c..._document
  if (/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(stem)) return true; // UUID

  // Ends with suffix patterns like _blocked1, _dup1, (1), (2), _copy
  if (/(_blocked\d*|_dup\d*|\(\d+\)|_copy\d*)$/i.test(stem)) return true;

  // Scanner, temp, download, and hash-prefix patterns
  if (/^(qptmp|scan[-_]?\d*|doc[-_]?\d*|img[-_]?\d*|photo[-_]?\d*|file[-_]?\d*|tmp[-_]?\d*|temp[-_]?\d*|fileopen[-_]?\d*|untitled|non_nomme|recap)/i.test(stem)) return true;

  // Generic prefix followed by digits or copy index (e.g. "invoice (8).pdf", "facture_1.pdf")
  if (/^(invoice|facture|receipt|download|document|recap)[-_\s\(\d]+$/i.test(stem)) return true;

  // Numbers at start of stem followed by hyphen (e.g. "98765432109876543210987-recap")
  if (/^\d{8,}[-_]/.test(stem)) return true;

  return false;
}

export function formatEntitySlug(str?: string): string {
  if (!str) return '';
  return str
    .split(/[\/\\_\-\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

export function generateIntelligentFilename(
  originalFilename: string,
  title?: string,
  category?: string,
  subcategory?: string,
  dateStr?: string
): string {
  const ext = path.extname(originalFilename) || '.pdf';

  // Only rename if the original filename is generic AND a non-empty title is provided!
  if (!title || title.trim().length === 0 || !isGenericFilename(originalFilename)) {
    return originalFilename;
  }

  const cleanCat = category ? category.toLowerCase().trim() : 'other';
  const cleanSub = subcategory && !isForbiddenSubcategory(subcategory) ? subcategory.toLowerCase().trim() : '';

  const entityName = formatEntitySlug(cleanSub || cleanCat) || 'Document';

  let formattedDate = '';
  if (dateStr) {
    const isoMatch = dateStr.match(/\b(20\d{2})[-/._]?(\d{2})[-/._]?(\d{2})\b/);
    if (isoMatch) {
      formattedDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    } else {
      const yearMatch = dateStr.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        formattedDate = yearMatch[1];
      }
    }
  }
  if (!formattedDate) {
    formattedDate = new Date().toISOString().split('T')[0];
  }

  let cleanTitle = (title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9\s-_]/g, '')
    .trim();

  // Slugify cleanTitle into CamelCase words
  const titleWords = cleanTitle
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  // Filter out redundant date or entity words from title
  const filteredWords = titleWords.filter(w => {
    const lower = w.toLowerCase();
    if (formattedDate.includes(lower)) return false;
    if (entityName.toLowerCase().includes(lower)) return false;
    return true;
  });

  const finalTitle = (filteredWords.length > 0 ? filteredWords.join('_') : 'Document').substring(0, 45);
  const intelligentName = `${formattedDate}_${entityName}_${finalTitle}${ext.toLowerCase()}`;

  logger.info('TAXONOMY', `Decision: Detected generic filename '${originalFilename}'. Intelligently renaming ➔ '${intelligentName}'`, {
    originalFilename,
    intelligentName,
    entityName,
    title
  });

  return intelligentName;
}

/**
 * Reduces one path segment to a safe slug before it is joined into a filesystem path.
 *
 * computeCanonicalPath() builds an archive path out of a category and subcategory that can
 * come straight from an HTTP body (POST /api/documents/:id/relocalize, which has no schema) or
 * an MCP tool call, neither of which validated them. A category of '..' escaped
 * OUTPUT_ROOT_DIR entirely and moved the user's document somewhere arbitrary. Anything that is
 * not a slug character is collapsed to '_', which neutralizes '..', '.' and any drive or UNC
 * prefix while leaving every real taxonomy slug (bulletin_salaire, credit_mutuel, cdi_cdd)
 * byte-identical.
 */
function sanitizePathSegment(segment: string, fallback: string): string {
  const cleaned = segment
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

export function computeCanonicalPath(
  originalPath: string,
  category: string,
  outputRootDir: string,
  subcategory?: string,
  dateStr?: string,
  title?: string
): string {
  const originalFile = path.basename(originalPath);
  const file = generateIntelligentFilename(originalFile, title, category, subcategory, dateStr);

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

  // Sanitize every segment before it reaches path.join — see sanitizePathSegment above. The
  // subcategory is still split first so legitimate multi-level nesting ('school/bachelor')
  // keeps working; each resulting part is then individually neutralized.
  const safeCat = sanitizePathSegment(cleanCat, 'other');
  const subParts = cleanSub.split(/[\/\\]+/).filter(Boolean)
    .map(part => sanitizePathSegment(part, 'general'))
    .filter(Boolean);
  return path.join(outputRootDir, safeCat, ...subParts, yearStr, file);
}

/**
 * Point every document's subcategory `oldSub` at `newSub` within one category, in the taxonomy.
 *
 * Renaming and merging are the same user gesture ("these two are the same thing") and differ only
 * in whether the destination already exists. Treating a merge as a rename — mutating the old entry's
 * id in place — leaves TWO entries sharing that id, and every later lookup has to guess between
 * them. Reconciling two spellings of one entity is the normal case here: an archive accrues
 * `bouyguestelecom` alongside `bouygues_telecom` because slug normalisation has no near-duplicate
 * check, so this path gets used precisely when the destination is already there.
 *
 * Mutates and returns `categories`. The old spelling survives as an alias on the winner, so a
 * document or classifier lookup using it still resolves.
 */
export function mergeSubcategoryInTaxonomy(
  categories: any[],
  categoryId: string,
  oldSub: string,
  newSub: string
): any[] {
  const cat = (categories || []).find(c => c.id === categoryId.toLowerCase().trim());
  if (!cat || !Array.isArray(cat.subcategories)) return categories;

  const from = oldSub.toLowerCase().trim();
  const to = newSub.toLowerCase().trim();
  if (!from || !to || from === to) return categories;

  const prettyName = to.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const source = cat.subcategories.find((s: any) => s.id === from);
  const target = cat.subcategories.find((s: any) => s.id === to);

  if (target) {
    target.aliases = Array.from(new Set([
      ...(target.aliases || []),
      ...((source && source.aliases) || []),
      from,
      to,
    ]));
    if (source) cat.subcategories = cat.subcategories.filter((s: any) => s !== source);
  } else if (source) {
    source.id = to;
    source.name = prettyName;
    source.aliases = Array.from(new Set([...(source.aliases || []), from, to]));
  } else {
    cat.subcategories.push({ id: to, name: prettyName, aliases: [to] });
  }

  return categories;
}
