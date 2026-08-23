import { CategoryItem, EntityDictionary } from './document.schema.js';

const DOMAIN_CATEGORY_MAP: Record<keyof EntityDictionary, string> = {
  banks: 'bank',
  energy: 'invoices',
  telecom: 'invoices',
  insurance: 'insurance',
  gov: 'administrative',
  health: 'health'
};

export const ALL_ENTITY_DOMAINS = Object.keys(DOMAIN_CATEGORY_MAP) as (keyof EntityDictionary)[];

export function matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[], dictionary: EntityDictionary): { categorie: string; subcategorie: string } | null {
  for (const domain of domains) {
    const categorie = DOMAIN_CATEGORY_MAP[domain];
    for (const entry of dictionary[domain]) {
      const candidates = [entry.name, ...entry.aliases];
      for (const candidate of candidates) {
        const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped.length === 0) continue;
        // Use Unicode-aware word boundaries to correctly handle accented characters
        if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(combined)) {
          return { categorie, subcategorie: entry.slug };
        }
      }
    }
  }
  return null;
}

export function buildEntityHintLine(categoryId: string, dictionary: EntityDictionary): string {
  const domains = ALL_ENTITY_DOMAINS.filter(domain => DOMAIN_CATEGORY_MAP[domain] === categoryId);
  const entries = domains.flatMap(domain => dictionary[domain]);
  if (entries.length === 0) return '';
  return ` Known real-world entities: ${entries.map(e => `${e.slug} (${e.name})`).join(', ')}.`;
}

export function normalizeSlug(str: string): string {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents (é -> e) before collapsing, same as taxonomy.ts's cleanTitle
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Preprocesses and normalizes raw extracted text by inserting spaces between fused/concatenated
 * words, numbers, and currency symbols (commonly caused by PDF text stripping or OCR).
 */
export function preprocessRawText(text: string): string {
  if (!text) return '';
  return text
    // Separate colon boundaries (e.g. name:PHAMD -> name: PHAMD, Invoice#INV -> Invoice # INV)
    .replace(/([a-zA-Z0-9]):([a-zA-Z0-9])/g, '$1: $2')
    .replace(/([a-zA-Z0-9])#([a-zA-Z0-9])/g, '$1 # $2')
    // Separate camelCase boundaries (e.g. InvoiceDetails -> Invoice Details)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Separate common fused document field keywords (e.g. Customersname -> Customers name, Totalpayable -> Total payable, Invoicedate -> Invoice date)
    .replace(/([a-zA-Z]+)(name|address|number|code|date|total|payable|price|rate|details|info|item|subtotal|charges|wrap|promotions|amount|vat|tax|invoice|seller|buyer)/gi, '$1 $2')
    // Separate letter-number boundaries (e.g. Deliverydate02 -> Deliverydate 02)
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    // Separate currency boundaries (e.g. Totalpayable€12.98 -> Totalpayable € 12.98)
    .replace(/([a-zA-Z0-9])([€$£])/g, '$1 $2')
    .replace(/([€$£])([0-9])/g, '$1 $2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// --- Ungrounded subcategory slug guard --------------------------------------------------
// When neither the curated regex list nor the entity dictionary recognizes a real entity,
// both the Qwen prompt (classifyPDFText) and ruleBasedClassify's last-resort fallback are
// tempted to invent a subcategory slug from the filename itself — e.g.
// "DcyJXe9MT9i7Un7tOlhU_StanW.pdf" -> "dcyjxe9mt9i7un7tolhu", "Page de confirmation.pdf"
// -> "page". That slug then gets permanently auto-created in categories.json (Golden Rule
// #5) even though it names nothing real. A "specific"-looking slug is only accepted here if
// it is actually grounded in the document's own text — not merely echoed from the filename
// or a generic/structural word.

const GENERIC_SLUG_DENYLIST = new Set([
  'general', 'other', 'divers', 'autre', 'autres', 'various', 'misc', 'note', 'notes',
  'info', 'page', 'bon', 'export', 'scan', 'copie', 'copy', 'document', 'doc', 'fichier',
  'file', 'image', 'confirmation', 'recu', 'releve', 'extrait', 'titre',
  'contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat',
  'anyscanner', 'camscanner', 'geniusscan', 'adobescan', 'tinyscanner', 'simplescan', 'docscanner',
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'pdf', 'txt', 'docx', 'xlsx'
]);

const MIN_GROUNDED_SLUG_LENGTH = 3;

function filenameSlugTokens(filename: string): string[] {
  const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
  return cleanName.split('_').filter(w => w.length >= 3 && !/^\d+$/.test(w));
}

function isFilenameEchoedSlug(slug: string, filename: string): boolean {
  const wholeFilenameSlug = normalizeSlug(filename.replace(/\.pdf$/i, ''));
  if (slug === wholeFilenameSlug) return true;
  return filenameSlugTokens(filename).some(t => t === slug || slug.includes(t) || t.includes(slug));
}

function countSlugOccurrences(slug: string, text: string): number {
  // Slugs are snake_case but real document text uses spaces/hyphens between words (e.g.
  // slug "france_travail" must still match body text "France Travail"), so underscores
  // become a flexible separator instead of a literal character. Also match French
  // connecting words like "de", "d'", "du", "des", "demande".
  const normText = (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normSlug = slug.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const escaped = normSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '(?:[\\s_-]+(?:de\\s+|d[\'’]|du\\s+|des\\s+|demande\\s+)?|[\\s_-]*)');
  if (!escaped) return 0;
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  return (normText.match(regex) || []).length;
}

/**
 * True only if `slug` looks like a real-world entity name grounded in the document's own
 * text, as opposed to a generic/structural word, gibberish, or an echo of the filename.
 * Used to gate the dynamic subcategory auto-create path in both classifyPDFText and
 * ruleBasedClassify. Exported for testing.
 */
export function isGroundedSubcategorySlug(slug: string, rawText: string, filename: string, personalNameDenylist: string[]): boolean {
  if (!slug || slug.length < MIN_GROUNDED_SLUG_LENGTH) return false;
  if (GENERIC_SLUG_DENYLIST.has(slug)) return false;
  // The document owner's own name appears in nearly every header/footer (postal address,
  // "cher Monsieur/Madame", etc.), so a naive grounding check would mistake the owner for
  // the actual issuer/entity. personalNameDenylist filters the owner's own name out so it
  // is never mistaken for a grounding match.
  const denylistSet = new Set(personalNameDenylist.map(n => n.toLowerCase().trim()));
  if (slug.split('_').some(part => denylistSet.has(part))) return false;

  const occurrences = countSlugOccurrences(slug, rawText || '');
  if (occurrences === 0) {
    // If body text OCR extracted little/no text (e.g. scanned image "Scanned with AnyScanner"),
    // but the slug's key compound words are explicitly present in the filename (e.g. 'vente_vehicule' in 'vehicule-Belleville-vente.pdf',
    // or 'declaration_vol' in 'declaration-de-vol.pdf'), accept it if it's a compound slug!
    const fnTokens = filenameSlugTokens(filename);
    const slugParts = slug.split('_').filter(p => p.length >= 3);
    const matchesFilename = slugParts.length >= 2 && slugParts.every(sp => fnTokens.some(ft => ft.includes(sp) || sp.includes(ft)));
    if (matchesFilename) return true;

    return false;
  }

  if (isFilenameEchoedSlug(slug, filename)) {
    // A slug that's also present in the filename is exactly what a hallucinating model
    // falls back to — require it to show up more than once in the body (letterhead,
    // footer, reference line, ...) rather than a single incidental mention.
    return occurrences >= 2;
  }

  return true;
}

function repairTruncatedJSON(text: string): string {
  let result = text;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const ch of result) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }

  if (inString) {
    result += '"';
  }
  while (stack.length > 0) {
    const open = stack.pop();
    result += open === '{' ? '}' : ']';
  }
  return result;
}

export function cleanAndParseJSON(rawStr: string): any {
  let text = rawStr.trim();
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in AI response');
  }
  text = text.substring(start);

  const end = text.lastIndexOf('}');
  const candidate = end !== -1 ? text.substring(0, end + 1) : text;
  const cleaned = candidate.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Response was likely truncated mid-generation (e.g. context/length limit cut off
    // markdown_content before the closing brace). Repair by closing any unterminated
    // string and any brackets left open, respecting string boundaries, then retry.
    const repaired = repairTruncatedJSON(text).replace(/,\s*([\}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

export function ruleBasedClassify(rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): { categorie: string; subcategorie: string; title: string; date: string; reason: string; payment_status?: string; invoice_type?: string } {
  const combined = (filename + ' ' + rawText.substring(0, 4000)).toLowerCase();

  // Generic bank-statement signal phrases (same signals as the Qwen prompt's STEP 1)
  // used to guard the gov (7b) and insurance-dictionary (8) branches so a
  // Crédit Mutuel / Chase / Barclays relevé isn't misfiled via a transaction-row mention of
  // CAF / AXA / etc. (Golden Rule #6 "archetypal trap").
  const looksLikeBankStatement = /(relev[ée]\s*de\s*compte|relev[ée]\s*de\s*ch[èe]ques|rlv[_-]|rlv_|rchq|rce[_-]|rce_|syn[_-]ep|synth[èe]se\s*(d'|de\s*)?[ée]pargne|solde\s*cr[ée]diteur|c\/c\s*eurocompte|relev[ée]\s*bancaire|extrait\s*de\s*compte|releve\s*de\s*cheques|bank\s*statement|account\s*statement|checking\s*account|savings\s*account|statement\s*of\s*account|credit\s*card\s*statement|opening\s*balance|closing\s*balance|bank\s*summary)/i.test(combined);

  let categorie = 'administrative';
  let subcategorie = 'general';
  let reason = 'Default administrative fallback';

  // 0a. Amendes / Traffic Fines & Penalty Receipts (High Priority Override)
  if (/\b(justificatif.*règlement.*amende|règlement.*amende|reglement.*amende|amende|amendes|amendes\.gouv\.fr|antai|avis de contravention|procès-verbal|proces-verbal|pv d'amende|traffic\s*fine|parking\s*ticket|penalty\s*charge)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'amende';
    reason = 'Matched traffic fine / penalty pattern (amendes.gouv.fr/antai)';
  }
  // 0b. Bank Statements, Check Statements & Savings Summaries (High Priority Override - Golden Rule #6)
  else if (looksLikeBankStatement) {
    categorie = 'bank';
    if (/bnp[-_ ]?paribas|bnpparibas|\bbnp\b/i.test(combined)) { subcategorie = 'bnp_paribas'; reason = 'Matched bank statement pattern -> BNP Paribas'; }
    else if (/\b(caisse de credit mutuel|crédit mutuel|credit mutuel|ccm marseille|creditmutuel)\b/i.test(combined) || /30004|rchq|rce|syn[_-]ep/i.test(combined)) { subcategorie = 'credit_mutuel'; reason = 'Matched bank statement pattern -> Crédit Mutuel'; }
    else if (/\b(société générale|societe generale)\b/i.test(combined)) { subcategorie = 'societe_generale'; reason = 'Matched bank statement pattern -> Société Générale'; }
    else if (/\b(boursorama|boursobank)\b/i.test(combined)) { subcategorie = 'boursobank'; reason = 'Matched bank statement pattern -> BoursoBank'; }
    else if (/\b(lcl|crédit lyonnais|credit lyonnais)\b/i.test(combined)) { subcategorie = 'lcl'; reason = 'Matched bank statement pattern -> LCL'; }
    else if (/\b(la banque postale|banque postale)\b/i.test(combined)) { subcategorie = 'la_banque_postale'; reason = 'Matched bank statement pattern -> La Banque Postale'; }
    else {
      const dictBank = matchEntityDictionary(combined, ['banks'], dictionary);
      if (dictBank) { subcategorie = dictBank.subcategorie; reason = `Matched bank statement pattern -> ${dictBank.subcategorie} (via dictionary)`; }
      else { subcategorie = 'releve_bancaire'; reason = 'Matched generic bank statement pattern'; }
    }
  }
  // Specific Bulletin de Salaire / Pay Slips Category (Universal for all employers/companies)
  else if (/bulletindesalaire|bulletin de salaire|bulletin de paie|fiche de paie|payslip|pay\s*slip|paystub|pay\s*stub|salary\s*statement|wage\s*statement|gross\s*pay|net\s*pay/i.test(combined)) {
    categorie = 'bulletin_salaire';
    const dictEmployer = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary);
    if (dictEmployer) {
      subcategorie = dictEmployer.subcategorie;
    } else {
      const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
      const words = cleanName.split('_').filter(w => w.length >= 3 && !/^\d+$/.test(w) && !['bulletin', 'salaire', 'paie', 'fiche', 'payslip', 'paystub', 'pdf', 'doc', 'copy', 'scan', 'de', 'du', 'des', 'le', 'la', 'les'].includes(w));
      if (words.length > 0) {
        const candidateSlug = normalizeSlug(words[0]);
        if (isGroundedSubcategorySlug(candidateSlug, rawText, filename, personalNameDenylist)) {
          subcategorie = candidateSlug;
        } else {
          subcategorie = 'employeur';
        }
      } else {
        subcategorie = 'employeur';
      }
    }
  }
  // Internship Attestations (Universal for all educational institutions & companies)
  else if (/attestation.*stage|stage|internship/i.test(combined)) {
    categorie = 'education';
    subcategorie = 'attestation_stage';
  }
  // 2DDoc Domicile Proof Attestations
  else if (/attestationtitulairecontrat2ddoc|2ddoc/i.test(combined)) {
    categorie = 'housing';
    subcategorie = 'justificatif_domicile';
  }
  // 1. Contracts, Commercial Mandates & General Conditions & Company Incorporation
  else if (/\b(contrat de travail|cdi|cdd|avenant au contrat|mandat d'agent commercial|mandat d'agent|droit à l'image|droit a l'image|cg de mon contrat|conditions générales|notice-attestation-employeur|attestation-employeur|attestation employeur|engagement|convention collective|acte de société|acte de societe|dépôt d'entreprise|depot d'entreprise|employment\s*contract|employment\s*agreement|terms\s*and\s*conditions|non-disclosure\s*agreement|nda|service\s*agreement|lease\s*agreement|tenancy\s*agreement)\b/i.test(combined)) {
    categorie = 'contracts';
    if (/\bcg|conditions générales|terms\s*and\s*conditions\b/i.test(combined)) subcategorie = 'conditions_generales';
    else if (/\battestation[ _-]employeur\b/i.test(combined)) subcategorie = 'attestation_employeur';
    else if (/\bacte de société|acte de societe|dépôt d'entreprise|depot d'entreprise\b/i.test(combined)) subcategorie = 'statuts_societe';
    else subcategorie = 'cdi_cdd';
  }
  // 2. Identity & Passports & Civil Records & Vehicle Cession
  else if (/(passeport|passport|carte d'identité|cni|piece_identite|pièce d'identité|piece d'identite|cancuoccongdan|giaypheplaixe|giay phep lai xe|permis de conduire|carte[-_ ]?de[-_ ]?séjour|carte[-_ ]?sejour|titre[-_ ]?de[-_ ]?séjour|titre[-_ ]?sejour|\btitre[-_][\p{L}]|récépissé|recipisse|rechung|carte vitale|cartevitale|acte de mariage|actemariage|acte de naissance|livret de famille|dces|cession.*véhicule|enregistrement.*dces|identity\s*card|id\s*card|driver'?s?\s*license|residence\s*permit|visa|birth\s*certificate|marriage\s*certificate)/iu.test(combined)) {
    categorie = 'identity';
    if (/(passeport|passport)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'passeport';
    else if (/(récépissé|recipisse|rec_hung|rechung)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'recipisse_sejour';
    else if (/(carte[-_ ]?de[-_ ]?séjour|carte[-_ ]?sejour|titre[-_ ]?de[-_ ]?séjour|titre[-_ ]?sejour|residence\s*permit|visa|\btitre[-_][\p{L}])(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'titre_sejour';
    else if (/(carte vitale|cartevitale)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'carte_vitale';
    else if (/(giaypheplaixe|giay phep lai xe|permis de conduire|permis|driver'?s?\s*license)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'permis_conduire';
    else if (/(dces|cession.*véhicule|enregistrement.*dces|carte[-_ ]?grise)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'carte_grise';
    else if (/(cancuoccongdan|carte d'identité|cni|piece_identite|pièce d'identité|piece d'identite|identity\s*card|id\s*card)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'carte_identite';
    else if (/(actemariage|acte de mariage|acte de naissance|birth\s*certificate|marriage\s*certificate)(?:[-_ ][\p{L}\p{N}_-]+)?/iu.test(combined)) subcategorie = 'acte_mariage';
  }
  // 3. Health / Medical & Work Stoppages
  else if (/\b(santé|sante|médical|medical|soins|dentaire|pharmacie|attestation de droits|attestationam|ameli|sécurité sociale|securite sociale|cpam|mutuelle|hospitalisation|arrêt de travail|arret de travail|avis d'arrêt|health\s*insurance|medical\s*bill|medical\s*claim|doctor'?s?\s*note|sick\s*leave|medical\s*statement|health\s*claim)\b/i.test(combined)) {
    categorie = 'health';
    if (/\barrêt de travail|arret de travail|avis d'arrêt|sick\s*leave|doctor'?s?\s*note\b/i.test(combined)) subcategorie = 'arret_travail';
    else if (/\bameli|assurance maladie|cpam|attestationam\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\bgan\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bclinic_x|clinic_x\b/i.test(combined)) subcategorie = 'clinic_x';
    else {
      const dictHealth = matchEntityDictionary(combined, ['health'], dictionary);
      if (dictHealth) subcategorie = dictHealth.subcategorie;
    }
  }
  // 4. Housing & Domicile Proof & Transport Schedules
  else if (!looksLikeBankStatement && /\b(justificatif de domicile|attestation d'hébergement|attestation hebergement|attestation cercles|cercles|declarationhonneur|quittance de loyer|foncia|logement|bus relais|bus|navigo|proof\s*of\s*address|utility\s*bill|rent\s*receipt)\b/i.test(combined)) {
    if (/\bbus|bus relais|navigo\b/i.test(combined)) {
      categorie = 'administrative';
      subcategorie = 'navigo';
    } else {
      categorie = 'housing';
      if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
      else subcategorie = 'justificatif_domicile';
    }
  }
  // 5. Education & Academic Diplomas & Transcripts
  else if (/\b(formation|bachelor|étudiant|scolarité|inscription|ecole_y|ecole_x|ecole_z|openclassrooms|école|université|diplôme|diplome|bulletinscolaire|certificat|alternance|l1informatique|relevé de notes|releve de notes|relevés de notes|bulletin de notes|academic\s*transcript|grade\s*report|certificate\s*of\s*enrollment|diploma|degree\s*certificate|tuition\s*fee)\b/i.test(combined)) {
    categorie = 'education';
    if (/\becole_x\b/i.test(combined)) subcategorie = 'ecole_x';
    else if (/\becole_y\b/i.test(combined)) subcategorie = 'ecole_y';
    else if (/\becole_z\b/i.test(combined)) subcategorie = 'ecole_z';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\balternance\b/i.test(combined)) subcategorie = 'alternance';
    else if (/\brelevé de notes|releve de notes|relevés de notes|bulletin de notes|academic\s*transcript|grade\s*report\b/i.test(combined)) subcategorie = 'releve_notes';
    else if (/\bdiplome|diplôme|bulletinscolaire|certificat|l1informatique|diploma|degree\b/i.test(combined)) subcategorie = 'diplomes';
  }
  // 6. Enterprise Invoices (Client Sales vs Supplier Purchases)
  else if (/\b(facture n°|facture no|facture|invoice|quittance|montant à payer|total ttc|bill|receipt|tax\s*invoice|amount\s*due|balance\s*due|total\s*due|payment\s*receipt)\b/i.test(combined)) {
    const isClientInvoice = /\b(facture client|facture de vente|facture émise|facturé à|destinataire|client_)\b/i.test(combined);
    categorie = isClientInvoice ? 'factures_clients' : 'invoices';

    if (/\bsfr\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else {
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy'], dictionary);
      if (dictVendor) {
        subcategorie = dictVendor.subcategorie;
      } else {
        const dictInsuranceViaFacture = matchEntityDictionary(combined, ['insurance'], dictionary);
        if (dictInsuranceViaFacture) {
          categorie = dictInsuranceViaFacture.categorie;
          subcategorie = dictInsuranceViaFacture.subcategorie;
        } else {
          // Dynamic Client or Vendor company name extraction from filename grounding
          const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
          const words = cleanName.split('_').filter(w => w.length >= 3 && !/^\d+$/.test(w) && !['facture', 'invoice', 'bill', 'receipt', 'client', 'fournisseur', 'supplier', 'pdf', 'doc', 'copy', 'scan', 'n°', 'no'].includes(w));
          if (words.length > 0) {
            const candidateSlug = normalizeSlug(words[0]);
            if (isGroundedSubcategorySlug(candidateSlug, rawText, filename, personalNameDenylist)) {
              subcategorie = candidateSlug;
            }
          }
        }
      }
    }
  }
  // 7. Taxes & Kbis & Company Registration Statements
  else if (!looksLikeBankStatement && /\b(kbis|extrait kbis|avis[ _-]d[ _-]impot|avis[ _-]d'impot|avis[ _-]impot|déclaration[ _-]d'impôt|taxe[ _-]fonciere|taxe[ _-]foncière|taxe[ _-]d'habitation|revenus[ _-]et[ _-]prelev|prélèvement[ _-]sociaux|prelev[ _-]sociaux|finances[ _-]publiques|dgfip|impôt|impots|dossier-rempli|dossier|tax\s*return|tax\s*assessment|w-?2|form\s*1040|tax\s*notice|hmrc|property\s*tax|inland\s*revenue)\b/i.test(combined)) {
    categorie = 'administrative';
    if (/\bkbis|extrait kbis\b/i.test(combined)) subcategorie = 'kbis';
    else if (/\bdossier-rempli|dossier\b/i.test(combined)) subcategorie = 'dossier_administratif';
    else subcategorie = 'impot';
  }
  // 7b. Government & Social Agencies
  else if (!looksLikeBankStatement && matchEntityDictionary(combined, ['gov'], dictionary)) {
    const dictGov = matchEntityDictionary(combined, ['gov'], dictionary)!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
  // 8. Insurance / Assurances & Theft Claims
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a|déclaration de vol|declaration de vol|découverte de vol|decourverte de vol|dépôt de plainte|depot de plainte|plainte|car\s*insurance|auto\s*insurance|home\s*insurance|renters?\s*insurance|liability\s*insurance|policy\s*schedule|insurance\s*certificate)\b/i.test(combined) || (!looksLikeBankStatement && matchEntityDictionary(combined, ['insurance'], dictionary))) {
    categorie = 'insurance';
    if (/\bdéclaration de vol|declaration de vol|découverte de vol|decourverte de vol|dépôt de plainte|depot de plainte|plainte\b/i.test(combined)) subcategorie = 'declaration_vol';
    else if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else {
      const dictInsurance = matchEntityDictionary(combined, ['insurance'], dictionary);
      if (dictInsurance) subcategorie = dictInsurance.subcategorie;
    }
  }
  // 9. Banks / Finance (Fallback if not caught by high-priority looksLikeBankStatement above)
  else if (matchEntityDictionary(combined, ['banks'], dictionary)) {
    const dictBank = matchEntityDictionary(combined, ['banks'], dictionary)!;
    categorie = dictBank.categorie;
    subcategorie = dictBank.subcategorie;
  }
  // 10. Recruitment
  else if (/\b(lettre de motivation|candidature|recrutement|curriculum|cv|postuler|entretien|recommandation|cover\s*letter|job\s*application|resume)\b/i.test(combined)) {
    categorie = 'recruitment';
  }
  // 11. Correspondence
  else if (/\b(yahoo mail|courrier|lettre|email|mail|recommandé|notification|letter|notice)\b/i.test(combined)) {
    categorie = 'correspondence';
  }
  // 12. Technical
  else if (/\b(manuel|guide|spécification|notice|documentation|technique|schema)\b/i.test(combined)) {
    categorie = 'technical';
  }
  // 13. Reports
  else if (/\b(rapport|compte-rendu|projet|livrable|synthèse)\b/i.test(combined)) {
    categorie = 'reports';
  }

  // Exact Subcategory Fallbacks & Dynamic Subcategory Generation from Filename Keywords
  if (subcategorie === 'general') {
    if (/\becole_x\b/i.test(combined)) subcategorie = 'ecole_x';
    else if (/\becole_y\b/i.test(combined)) subcategorie = 'ecole_y';
    else if (/\becole_z\b/i.test(combined)) subcategorie = 'ecole_z';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\bcarrefour\b/i.test(combined)) subcategorie = 'carrefour';
    else if (/\bkairos\b/i.test(combined)) subcategorie = 'kairos';
    else if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else if (/\b(gan|gan santé|gan assurances)\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bcapgemini\b/i.test(combined)) subcategorie = 'capgemini';
    else if (/\b(sfr|red by sfr)\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bbouygues\b/i.test(combined)) subcategorie = 'bouygues';
    else if (/\bfree\b/i.test(combined)) subcategorie = 'free';
    else if (/\b(ameli|assurance maladie|cpam)\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\b(navigo|ile-de-france mobilités|ratp)\b/i.test(combined)) subcategorie = 'navigo';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else if (/\bfnac\b/i.test(combined)) subcategorie = 'fnac';
    else if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else if (/\b(page[ _-]de[ _-]confirmation|confirmation)\b/i.test(combined)) {
      categorie = 'administrative';
      subcategorie = 'attestation_confirmation';
    }
    else if (/\b(summary|cpf|docusign)\b/i.test(combined)) {
      categorie = 'education';
      subcategorie = 'cpf';
    }
    else if (/\b(bctc|bctcth|giai[ _-]trinh|bao[ _-]cao[ _-]tai[ _-]chinh)\b/i.test(combined)) {
      categorie = 'administrative';
      subcategorie = 'bctc';
    }
    else if (/\b(bulletindesalaire|bulletin[ _-]de[ _-]salaire|fiche[ _-]de[ _-]paie)\b/i.test(combined)) {
      categorie = 'bulletin_salaire';
      subcategorie = 'bulletin_salaire';
    }
    else if (/\b(facture|invoice|bill|receipt|casque)\b/i.test(combined)) {
      if (categorie !== 'factures_clients') {
        categorie = 'invoices';
      }
      subcategorie = 'facture';
    }
    else if (matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)) {
      const dictAny = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)!;
      categorie = dictAny.categorie;
      subcategorie = dictAny.subcategorie;
    }
    else {
      // Dynamic Subcategory Extraction from Filename Words — ONLY accepted if the
      // resulting slug is actually grounded in the document text (isGroundedSubcategorySlug
      // above). Previously this unconditionally promoted a filename fragment (or a fully
      // random filename) to a permanent subcategory; now an ungrounded candidate is left as
      // 'general' so the caller's strict fail guard (Golden Rule #4) can BLOCK it instead.
      const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
      const words = cleanName.split('_').filter(w => w.length > 2 && !/^\d+$/.test(w) && !['pdf', 'doc', 'document', 'copy', 'scan', 'the', 'and', 'for', 'mon', 'mes', 'une', 'des', 'sur', 'les', 'par'].includes(w));
      if (words.length > 0) {
        const candidate = words.find(w => !['contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'].includes(w)) || words[0];
        if (candidate && candidate.length >= 3) {
          const candidateSlug = normalizeSlug(candidate);
          if (isGroundedSubcategorySlug(candidateSlug, rawText, filename, personalNameDenylist)) {
            subcategorie = candidateSlug;
          }
        }
      }
    }
  }

  let date = new Date().toISOString().split('T')[0];
  const compactDateMatch = combined.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  const dateMatch = combined.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/) ||
                    combined.match(/\b(0[1-9]|[12]\d|3[01])[-/](0[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (compactDateMatch) {
    date = `${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`;
  } else if (dateMatch) {
    if (dateMatch[1].length === 4) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } else {
      date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  const title = filename.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();

  const isPaid = /\b(payé|payee|acquittée|acquittee|réglé|regle|virement|solde 0|déjà réglé|paye)\b/iu.test(combined);
  const isUnpaid = /\b(à payer|a payer|en attente|reste à régler|reste a regler|échéance|echeance|solde à payer)\b/iu.test(combined);
  const payment_status = isPaid ? 'PAID' : (isUnpaid ? 'UNPAID' : 'UNKNOWN');
  const invoice_type = (categorie === 'factures_clients') ? 'CLIENT' : (categorie === 'invoices' ? 'SUPPLIER' : 'NONE');

  return { categorie, subcategorie, title, date, reason, payment_status, invoice_type };
}

export function extractRuleBasedContact(rawText: string): {
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  contact_address: string;
  contact_website: string;
} {
  // Regex guessing disabled by user request — contact fields are populated solely via AI model JSON output
  return { contact_name: '', contact_email: '', contact_phone: '', contact_address: '', contact_website: '' };
}

// Formats a Date using its LOCAL calendar fields (not toISOString, which converts to UTC and
// shifts "today" by a day for any timezone ahead of UTC — e.g. Europe/Paris at local midnight).
export function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  const str = (dateStr || '').trim();

  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { year: +iso[1], month: +iso[2], day: +iso[3] };

  const frLong = str.match(/^(\d{2})[/.\-](\d{2})[/.\-](\d{4})$/);
  if (frLong) return { year: +frLong[3], month: +frLong[2], day: +frLong[1] };

  const frShort = str.match(/^(\d{2})[/.\-](\d{2})[/.\-](\d{2})$/);
  if (frShort) return { year: 2000 + +frShort[3], month: +frShort[2], day: +frShort[1] };

  return null;
}

// Defense-in-depth guard for Step D's "date" field: the classification LLM occasionally
// mis-derives a two-digit-year date from OCR-garbled source text (e.g. "30/11/26" read from a
// printed "30/11/25"), producing a "date" later than today for an otherwise-past document. When
// that happens AND the document's own titre states a different, non-future year (payslip titles
// always carry the pay period's year — "Bulletin de salaire - Novembre 2025"), trust the titre's
// year over the ambiguous digit. Declines to touch anything it isn't confident about (no titre
// year found, titre year matches already, or the "corrected" date would itself land in the future).
export function reconcileDocumentDate(rawDate: string, titre: string, now: Date = new Date()): { date: string; corrected: boolean; reason?: string } {
  const parsed = parseDateParts(rawDate);
  if (!parsed) return { date: rawDate, corrected: false };

  const parsedTimestamp = new Date(parsed.year, parsed.month - 1, parsed.day).getTime();
  if (parsedTimestamp <= now.getTime()) {
    return { date: rawDate, corrected: false };
  }

  const titleYearMatch = (titre || '').match(/\b(20\d{2})\b/);
  if (!titleYearMatch) return { date: rawDate, corrected: false };

  const titleYear = parseInt(titleYearMatch[1], 10);
  if (titleYear === parsed.year) return { date: rawDate, corrected: false };

  const correctedTimestamp = new Date(titleYear, parsed.month - 1, parsed.day).getTime();
  if (correctedTimestamp > now.getTime()) return { date: rawDate, corrected: false };

  const correctedDate = `${titleYear}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
  return {
    date: correctedDate,
    corrected: true,
    reason: `"${rawDate}" is later than today (${formatLocalDate(now)}); corrected year to ${titleYear} to match the titre's stated period`
  };
}

export function buildCategoriesDescriptionStr(categoriesConfig: { categories: CategoryItem[] }, dictionary: EntityDictionary): string {
  return categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    const entityHint = buildEntityHintLine(c.id, dictionary);
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}].${entityHint}`;
  }).join('\n');
}
