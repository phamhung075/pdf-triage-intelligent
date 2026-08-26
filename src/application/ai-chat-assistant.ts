import { getAllDocuments, searchDocumentsFts, DocumentRecord } from '../infrastructure/db/database.js';
import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { detectFileType } from '../domain/taxonomy.js';
import { formatLocalDate } from '../domain/classification.js';
import { logger } from '../infrastructure/logger.js';
import { buildFtsMatchExpression, relaxQuery, type StructuredQuery } from '../domain/chat-query.js';
import { planQuery } from './chat-query-planner.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  answer: string;
  matchedDocuments: any[];
}

/**
 * Parses ISO or DD/MM/YYYY date strings into a comparable timestamp.
 */
function parseDocDate(dateStr?: string): number {
  if (!dateStr) return 0;
  const str = dateStr.trim();
  
  // ISO YYYY-MM-DD
  const isoMatch = str.match(/\b(20\d{2})[-/._]?(\d{2})[-/._]?(\d{2})\b/);
  if (isoMatch) {
    return new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`).getTime() || 0;
  }

  // French DD/MM/YYYY
  const frMatch = str.match(/\b(\d{2})[-/._]?(\d{2})[-/._]?(20\d{2})\b/);
  if (frMatch) {
    return new Date(`${frMatch[3]}-${frMatch[2]}-${frMatch[1]}`).getTime() || 0;
  }

  // Year only
  const yearMatch = str.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    return new Date(`${yearMatch[1]}-01-01`).getTime() || 0;
  }

  return 0;
}

/**
 * Detects explicit quantity requested in prompt (e.g. "3 derniers", "last 2", "top 5").
 */
function extractRequestedCount(userMessage: string): number | null {
  const lower = userMessage.toLowerCase();
  
  const numMatch = lower.match(/\b(\d+)\s*(derniers?|dernieres?|fiches?|bulletins?|factures?|pay|slips?|statements?|relevés?|docs?|documents?)\b/i)
    || lower.match(/\b(derniers?|dernieres?|last)\s*(\d+)\b/i);

  if (numMatch) {
    const val = parseInt(numMatch[1] || numMatch[2], 10);
    if (!isNaN(val) && val > 0 && val <= 20) return val;
  }

  if (/\b(trois|three)\b/i.test(lower)) return 3;
  if (/\b(deux|two)\b/i.test(lower)) return 2;
  if (/\b(single|last|dernier|dernière)\b/i.test(lower)) return 1;

  return null;
}

/**
 * Searches local documents using exact intent, category filtering, and date sorting.
 */
export async function searchRelevantDocuments(userMessage: string): Promise<DocumentRecord[]> {
  const allDocs = await getAllDocuments();
  if (allDocs.length === 0) return [];

  const lower = userMessage.toLowerCase().trim();
  const requestedCount = extractRequestedCount(userMessage);

  // General Intent scoring
  const queryTokens = lower
    .split(/[\s,.;:!?\/\\_-]+/)
    .filter(t => t.length > 2);

  const scored = allDocs.map(doc => {
    let score = 0;
    const catLower = (doc.category || '').toLowerCase();
    const subLower = (doc.subcategory || '').toLowerCase();
    const titleLower = (doc.title || '').toLowerCase();
    const fileLower = (doc.original_filename || '').toLowerCase();
    const summaryLower = (doc.summary || '').toLowerCase();

    if (lower.includes(catLower) && catLower.length > 2) score += 10;
    if (subLower && lower.includes(subLower) && subLower.length > 2) score += 15;

    queryTokens.forEach(token => {
      if (titleLower.includes(token)) score += 6;
      if (fileLower.includes(token)) score += 5;
      if (subLower.includes(token)) score += 4;
      if (catLower.includes(token)) score += 3;
      if (summaryLower.includes(token)) score += 2;
    });

    return { doc, score, timestamp: parseDocDate(doc.date) };
  });

  const matches = scored
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.timestamp - a.timestamp;
    })
    .map(item => item.doc);

  if (matches.length === 0) {
    const sortedAll = [...allDocs].sort((a, b) => parseDocDate(b.date) - parseDocDate(a.date));
    return sortedAll.slice(0, requestedCount || 5);
  }

  const limit = requestedCount || 10;
  return matches.slice(0, limit);
}

/**
 * Pay-slip-only period key: `null` for anything else, so `dedupeByPeriod` leaves non-pay-slip
 * documents alone.
 */
function paySlipPeriodKey(doc: DocumentRecord): string | null {
  if ((doc.category || '').toLowerCase() !== 'bulletin_salaire') return null;
  const ts = parseDocDate(doc.date);
  return ts ? new Date(ts).toISOString().slice(0, 7) : `no-date-${doc.id}`;
}

/**
 * Collapses re-scanned copies of the same pay period, keeping the most recently imported.
 *
 * Two imports of the same month must not occupy two of the limited result slots and push a
 * distinct, still-requested month out — the user-reported "only 2 of my 3 last months" bug.
 *
 * Scoped to pay slips on purpose: they are inherently one-per-month-per-employer, so two in one
 * month means a re-scan. No other document type carries that guarantee — five invoices in March
 * are five invoices, and collapsing them by month would be a worse bug than the one this fixes.
 * Input order is preserved; callers rank before calling.
 */
export function dedupeByPeriod(docs: DocumentRecord[]): DocumentRecord[] {
  const winnerIdByPeriod = new Map<string, number>();
  for (const doc of docs) {
    const key = paySlipPeriodKey(doc);
    if (key === null) continue;
    const current = winnerIdByPeriod.get(key);
    if (current === undefined || doc.id > current) winnerIdByPeriod.set(key, doc.id);
  }
  return docs.filter(doc => {
    const key = paySlipPeriodKey(doc);
    return key === null || winnerIdByPeriod.get(key) === doc.id;
  });
}

/**
 * The retrieval entry point: plan the query, run it through BM25, relax it if it found nothing.
 *
 * The old token scorer survives only as the last resort — when FTS5 is unavailable, when the
 * MATCH throws, or when the ladder is exhausted. It is no longer the primary path.
 */
export async function retrieveDocuments(userMessage: string, now: Date = new Date()): Promise<DocumentRecord[]> {
  try {
    const plan = await planQuery(userMessage, now);

    // A number the user actually typed ("les 3 derniers") beats the model re-deriving it. The same
    // resolved value feeds citation pruning below, so retrieval and pruning cannot disagree about
    // how many documents were asked for — that disagreement is what silently dropped documents before.
    const limit = extractRequestedCount(userMessage) ?? plan.limit ?? 10;
    const filters = {
      category: plan.category,
      subcategory: plan.subcategory,
      dateFrom: plan.dateFrom,
      dateTo: plan.dateTo,
    };

    let current: StructuredQuery | null = plan;
    while (current) {
      const matchExpr = buildFtsMatchExpression(current);
      if (!matchExpr) break;
      try {
        const hits = await searchDocumentsFts(matchExpr, filters, limit);
        if (hits.length > 0) return hits;
      } catch (err: any) {
        logger.warn('CHAT_ASSISTANT', `FTS5 search failed (${err?.message}); using the token scorer.`);
        break;
      }
      current = relaxQuery(current);
    }
  } catch (err: any) {
    // processChatQuery does not wrap this call in its own try/catch, so anything thrown here
    // propagates straight to the HTTP route and surfaces as a search error to the user — exactly
    // what the "never surface a search error" constraint forbids. Degrade the same way an FTS5
    // failure does instead of letting a planning failure escape.
    logger.warn('CHAT_ASSISTANT', `Query planning failed (${err?.message}); using the token scorer.`);
  }

  return searchRelevantDocuments(userMessage);
}

/**
 * Builds system prompt for Qwen 3.5 AI with local document context.
 */
export function buildPromptContext(userMessage: string, documents: DocumentRecord[], now: Date = new Date()): { system: string; userPrompt: string } {
  const docSummaries = documents.map(d => {
    const sub = d.subcategory ? `${d.category}/${d.subcategory}` : d.category;
    const fType = d.file_type || detectFileType(d.original_filename || d.title);
    return `[Doc #${d.id}] Title: "${d.title}" | Format: ${fType} | Category: ${sub} | Date: ${d.date || 'N/A'} | Amount: ${d.total_amount || 'N/A'}\nSummary: ${d.summary || 'No summary'}`;
  }).join('\n\n');

  const system = `Tu es un assistant archiviste IA local expert pour le tri et la préparation de dossiers administratifs (via outils MCP locaux).
Ta mission est de répondre à la demande de l'utilisateur de manière synthétique et professionnelle en français.

Nous sommes le ${formatLocalDate(now)}. Utilise cette date comme "aujourd'hui" pour toute expression temporelle relative dans la demande de l'utilisateur (ex: "les 3 derniers mois", "cette année", "le mois dernier") — calcule la période exacte à partir de cette date avant de comparer aux dates des documents fournis.

Consignes strictes:
1. Analyse les documents fournis ci-dessous (triés par pertinence et par date via les outils MCP).
2. Sélectionne et liste EXACTEMENT les documents nécessaires qui répondent à la demande.
3. Pour CHAQUE document listé ci-dessous qui fait partie de ta réponse, mentionne obligatoirement son identifiant sous la forme [Doc #ID: Titre] (exemple: [Doc #1810: Bulletin de Salaire - Décembre 2024]) — n'omets aucune citation, un document non cité sera considéré comme non inclus dans la réponse.
4. Si des pièces obligatoires pour le dossier sont absentes de l'archive, indique-les sous "⚠️ Documents manquants suggérés".
5. Réponds directement en texte clair Markdown sans balises JSON raw.`;

  const userPrompt = `Documents disponibles dans la base locale (via MCP):\n${docSummaries || 'Aucun document spécifique trouvé.'}\n\nDemande de l'utilisateur: "${userMessage}"`;

  return { system, userPrompt };
}

/**
 * Main chat handler: processes user query with MCP tool document retrieval & Qwen 3.5 completion.
 */
export async function processChatQuery(userMessage: string, history: ChatMessage[] = [], now: Date = new Date()): Promise<ChatResponse> {
  logger.info('CHAT_ASSISTANT', `Processing web chat query via MCP tools: "${userMessage}"`);

  let matchedDocs = dedupeByPeriod(await retrieveDocuments(userMessage, now));

  const { system, userPrompt } = buildPromptContext(userMessage, matchedDocs, now);

  try {
    const aiResult = await requestTextChatCompletion(system, userPrompt);
    const answerText = aiResult.response.trim();

    // Extract all [Doc #ID] numbers cited in the AI answer text
    const citedDocIds = new Set<number>();
    const citeMatches = answerText.matchAll(/\[Doc #(\d+)/gi);
    for (const match of citeMatches) {
      const id = parseInt(match[1], 10);
      if (!isNaN(id)) citedDocIds.add(id);
    }

    // Filter matchedDocuments to ONLY return documents cited by AI, or fallback to top candidates.
    // Trust the AI's narrower citation-based selection only when it cites at least half of what
    // it was actually given (or, when the user asked for an explicit count, at least that many) —
    // a small citation count against a much larger fuzzy-matched candidate set is deliberate
    // curation, but under-citing an already-precise, small retrieval (e.g. a "3 last pay slips"
    // query) is far more likely the model simply forgot to tag one in its prose than a deliberate
    // exclusion. Silently dropping correctly-retrieved documents in that case was the root cause
    // of a user-reported bug where a chat answer showed fewer documents than were actually found.
    let finalDocs = matchedDocs;
    if (citedDocIds.size > 0 && matchedDocs.length > 0) {
      const cited = matchedDocs.filter(d => citedDocIds.has(d.id));
      const requestedCount = extractRequestedCount(userMessage);
      const minExpected = requestedCount
        ? Math.min(requestedCount, matchedDocs.length)
        : Math.ceil(matchedDocs.length / 2);
      finalDocs = cited.length >= minExpected ? cited : matchedDocs;
    }

    const formattedDocs = finalDocs.map(d => ({
      id: d.id,
      checksum: (d as any).checksum || '',
      title: d.title,
      date: d.date || '',
      category: d.category,
      subcategory: d.subcategory || 'general',
      file_type: d.file_type || detectFileType((d as any).original_filename || d.title),
      summary: d.summary || '',
      total_amount: d.total_amount || '',
      original_filename: (d as any).original_filename || d.title,
      new_path: d.new_path || (d as any).original_path || ''
    }));

    return {
      answer: answerText || `Voici les ${formattedDocs.length} document(s) sélectionné(s) correspondant à votre demande :`,
      matchedDocuments: formattedDocs
    };
  } catch (err: any) {
    logger.error('CHAT_ASSISTANT', `Failed to generate AI response: ${err.message}`);

    const formattedDocs = matchedDocs.map(d => ({
      id: d.id,
      checksum: (d as any).checksum || '',
      title: d.title,
      date: d.date || '',
      category: d.category,
      subcategory: d.subcategory || 'general',
      summary: d.summary || '',
      total_amount: d.total_amount || '',
      original_filename: (d as any).original_filename || d.title,
      new_path: d.new_path || (d as any).original_path || ''
    }));

    return {
      answer: `Voici les ${formattedDocs.length} document(s) trouvé(s) dans vos archives pour votre demande :`,
      matchedDocuments: formattedDocs
    };
  }
}
