import { PriorityRule } from './prompt-personalization.js';
import { isForbiddenSubcategory } from './taxonomy.js';

// Turns a human move decision (see infrastructure/manual-decisions-store.ts) into a STEP 0
// priority rule the classifier can learn from on FUTURE runs — the missing half of Golden
// Rule #18's feedback-teaches-AI loop. Until this module existed, a relocalize reason was
// forwarded to Qwen only for the document being moved and then parked in the audit log;
// nothing ever re-read the log, so the correction taught the AI nothing beyond that one move.
//
// This is deliberately conservative: a bad auto-derived keyword misclassifies OTHER documents,
// so derivation trusts only what identifies the document's ISSUER (filename codes, scanner
// prefixes, distinctive title tokens), never the generic words that merely say what kind of
// document it is ("releve", "facture", "contrat"…). Every derived rule is visible and editable
// in the Settings → Human Decisions tab, and disabled/deleted the moment it misfires.
//
// The derived rules are injected through the SAME {{USER_PRIORITY_RULES}} STEP 0 block as the
// hand-curated .prompts.private.json rules (see prompt-personalization-store.ts), so both the
// Qwen prompt and the deterministic ruleBasedClassify fallback (matchPriorityRules) stay
// logically aligned — Golden Rule #6.

/** Tokens that describe the document TYPE rather than its issuer — useless as match keywords. */
const STOPWORD_TOKENS = new Set([
  // file mechanics / generic nouns
  'pdf', 'scan', 'scans', 'scanned', 'doc', 'docs', 'document', 'documents',
  'file', 'files', 'copy', 'copie', 'final', 'new', 'nouveau', 'nouvelle', 'num', 'n',
  // generic document-type words (FR + EN)
  'releve', 'releves', 'releve_compte', 'statement', 'statements', 'facture', 'factures',
  'invoice', 'invoices', 'recu', 'recus', 'receipt', 'receipts', 'lettre', 'courrier',
  'courriers', 'letter', 'letters', 'avis', 'notification', 'notifications', 'declaration',
  'declarations', 'attestation', 'attestations', 'certificate', 'certificates', 'contrat',
  'contrats', 'contract', 'contracts', 'devis', 'quote', 'quotes', 'justificatif',
  'justificatifs', 'extrait', 'extraits', 'compte', 'comptes', 'account', 'accounts',
  'fiche', 'fiches', 'bulletin', 'bulletins', 'salaire', 'salaires', 'pay', 'payroll',
  'paie', 'slip', 'slips', 'paycheck', 'paychecks', 'tax', 'taxes', 'impot', 'impots',
  'banque', 'banques', 'bank', 'banks', 'assurance', 'assurances', 'insurance', 'insurances',
  'mutuelle', 'mutuelles', 'sante', 'sante_', 'health', 'medical', 'identite', 'identity',
  'passeport', 'passport', 'domicile', 'logement', 'housing', 'rent', 'quittance', 'quittances',
  'recapitulatif', 'recapitulatifs', 'tiers', 'titre', 'titres', 'mail', 'email', 'courriel',
  'sms', 'detail', 'details', 'total', 'totaux', 'solde', 'montant', 'montants', 'numero',
  'number', 'ref', 'reference', 'date', 'dates', 'page', 'pages', 'annee', 'year', 'years',
  'mois', 'month', 'months', 'jour', 'jours', 'day', 'days', 'semaine', 'week', 'weeks',
  'prelevement', 'virement', 'virements', 'transfert', 'transferts', 'especes', 'cash',
  'cheque', 'cheques', 'check', 'checks', 'ticket', 'tickets', 'envoi', 'envois', 'reception',
  'reponse', 'demande', 'demandes', 'formulaire', 'formulaires', 'form', 'forms', 'note',
  'notes', 'memo', 'memos', 'liste', 'listes', 'list', 'lists', 'synthese', 'resume',
  'summary', 'rapport', 'rapports', 'report', 'reports', 'guide', 'guides', 'manuel',
  'manuels', 'manual', 'manuals', 'modele', 'template', 'templates', 'projet', 'projets',
  'project', 'projects', 'stage', 'stages', 'cv', 'motivation', 'alerte', 'alertes', 'alert',
  'alerts', 'rapprochement', 'rapprochements', 'historique', 'historiques', 'history', 'log',
  'logs', 'journal', 'journaux', 'registre', 'registres', 'proces', 'jugement', 'jugements',
  'ordonnance', 'ordonnances', 'decision', 'arrivee', 'depart', 'entree', 'sortie', 'sorties',
  'formulaire', 'questionnaire', 'enquete', 'sondage', 'survey', 'preuve', 'proof', 'piece',
  'pieces', 'document_', 'doc_', 'scan_', 'img', 'img_', 'photo', 'photos', 'image', 'images',
  'jpg', 'jpeg', 'png', 'tiff', 'webp',
  // months (FR + EN)
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre',
  'octobre', 'novembre', 'decembre',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  // common conversational noise
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'vous', 'votre', 'monsieur',
  'madame', 'bonjour', 'salutation', 'cordialement', 'merci', 'objet', 're', 'fw', 'fwd',
  'attn', 'attention', 'auto', 'automatique', 'automatic', 'generated', 'system', 'système',
  'online', 'telephone', 'phone', 'portable', 'mobile', 'adresse', 'address', 'site', 'web',
  'mme', 'mlle', 'dr', 'prof', 'societe', 'sarl', 'sa', 'eurl', 'sas', 'gmbh', 'ltd', 'llc',
  'inc', 'corp', 'company', 'compagnie', 'entreprise', 'group', 'groupe',
  // more identity/administrative document words
  'recepisse', 'sejour', 'autorisation', 'autorisations', 'certificat', 'certificats',
  'acte', 'actes', 'duplicata', 'original', 'expiration', 'renouvellement', 'validite',
  'suivi', 'reclamation', 'reclamations', 'plainte', 'litige', 'litiges', 'conflit',
  'arbitrage', 'feuille', 'feuilles', 'tableau', 'tableaux', 'grille', 'grilles', 'pointage',
]);

/** Strips diacritics so 'relevé' and 'releve' hit the same stopword entry. */
function deaccent(token: string): string {
  return token.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const MIN_KEYWORD_LENGTH = 3;
/** Upper bound on keywords auto-derived from one decision. */
const MAX_KEYWORDS_PER_DECISION = 3;
/** Upper bound on decision-derived rules injected into one prompt (newest first). */
const MAX_DECISION_RULES = 25;

function tokenize(value: string): string[] {
  // \p{L}\p{N} with the u flag keeps accented letters INSIDE tokens ("relevé" stays whole so
  // deaccent() can stopword it) — a plain [^a-z0-9] class would treat "é" as a separator and
  // produce the mangled token "relev".
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(t => t.trim())
    .filter(Boolean);
}

function isUsefulToken(token: string): boolean {
  if (token.length < MIN_KEYWORD_LENGTH) return false;
  // Pure digits are years, dates or account numbers — never distinctive of an issuer.
  if (/^[0-9]+$/.test(token)) return false;
  // Accent-insensitive stopword check: 'relevé' and 'releve' must both be filtered.
  if (STOPWORD_TOKENS.has(deaccent(token))) return false;
  return true;
}

/**
 * Derives conservative match keywords from the original filename + title of a moved document.
 *
 * Sources, in priority order: the filename stem (bank product codes, scanner prefixes — the
 * signals taxonomy.md says are the most distinctive) then the title. A token found in BOTH is
 * the strongest signal and outranks everything else. Returns at most MAX_KEYWORDS_PER_DECISION
 * tokens, lowercased, deduplicated, stopword- and digit-filtered. Empty array when nothing
 * distinctive can be found — the decision is still registered and visible in the tab, it just
 * does not become an active rule until the user edits in keywords.
 */
export function deriveRuleKeywords(filename: string, title: string): string[] {
  const fileTokens = tokenize((filename || '').replace(/\.[^.]+$/, ''));
  const titleTokens = tokenize(title || '');

  const candidates: Array<{ token: string; score: number }> = [];
  const seen = new Set<string>();
  const push = (token: string, score: number) => {
    if (!isUsefulToken(token) || seen.has(token)) return;
    seen.add(token);
    candidates.push({ token, score });
  };

  for (const t of fileTokens) push(t, titleTokens.includes(t) ? 2 : 1);
  for (const t of titleTokens) push(t, 1);

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_KEYWORDS_PER_DECISION).map(c => c.token);
}

/** Structural subset of a manual-decisions record — keeps this domain module free of infra types. */
export interface HumanDecisionLike {
  id?: number;
  original_filename?: string;
  title?: string;
  new_category?: string;
  new_subcategory?: string;
  user_feedback_reason?: string;
  rule_keywords?: string[];
  enabled?: number;
  created_at?: string;
}

const BOILERPLATE_REASONS = new Set(['Manual user selection', 'AI re-analysis']);

/**
 * Maps enabled human decisions (newest first) to STEP 0 priority rules.
 *
 * Rules whose keywords had to be derived on the fly (legacy records saved before keyword
 * derivation existed) get the same derivation as a fresh move. A decision with no usable
 * keyword, an empty target category, or a forbidden target subcategory is skipped — a rule
 * that cannot match, or that would violate Golden Rule #4, must never reach the prompt.
 *
 * Only the most recent `maxRules` decisions are injected, so a growing feedback log cannot
 * bloat the prompt into the token budget.
 */
export function decisionsToPriorityRules(
  decisions: HumanDecisionLike[],
  maxRules: number = MAX_DECISION_RULES
): PriorityRule[] {
  const rules: PriorityRule[] = [];
  for (const d of decisions) {
    if (rules.length >= maxRules) break;
    if (d.enabled === 0) continue;

    const category = (d.new_category || '').toLowerCase().trim();
    if (!category) continue;

    const subcategory = (d.new_subcategory || '').toLowerCase().trim();
    if (subcategory && isForbiddenSubcategory(subcategory)) continue;

    const keywords = (
      Array.isArray(d.rule_keywords) && d.rule_keywords.some(k => k.trim())
        ? d.rule_keywords
        : deriveRuleKeywords(d.original_filename || '', d.title || '')
    )
      .map(k => k.trim())
      .filter(k => k.length > 0);
    if (keywords.length === 0) continue;

    const noteParts: string[] = ['Auto-learned from a human move'];
    if (d.id) noteParts.push(`(decision #${d.id})`);
    const reason = (d.user_feedback_reason || '').trim();
    if (reason && !BOILERPLATE_REASONS.has(reason)) noteParts.push(`— ${reason}`);
    const note = `${noteParts.join(' ')}.`;

    rules.push({
      keywords: keywords.slice(0, MAX_KEYWORDS_PER_DECISION),
      category,
      ...(subcategory ? { subcategory } : {}),
      note: note.length > 240 ? `${note.slice(0, 240)}…` : note,
    });
  }
  return rules;
}
