import { getAllDocuments, DocumentRecord } from '../infrastructure/db/database.js';
import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { handleMcpToolCall } from '../infrastructure/mcp/mcp-server.js';
import { detectFileType } from '../domain/taxonomy.js';
import { logger } from '../infrastructure/logger.js';

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
  if (/\b(un|une|single|last|dernier|dernière)\b/i.test(lower)) return 1;

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

  // Pay Slip Intent: strict filtering to category 'bulletin_salaire'
  const isPaySlipQuery = lower.includes('fiche de paie') || lower.includes('bulletin de salaire') || lower.includes('bulletin de paie') || lower.includes('pay slip');
  if (isPaySlipQuery) {
    const paySlips = allDocs.filter(d => {
      const cat = (d.category || '').toLowerCase();
      const title = (d.title || '').toLowerCase();
      if (title.includes('relevé de compte') || title.includes('cheques postaux') || title.includes('banque')) return false;
      return cat === 'bulletin_salaire' || title.includes('bulletin') || title.includes('salaire') || title.includes('paie');
    });

    paySlips.sort((a, b) => parseDocDate(b.date) - parseDocDate(a.date));
    const limit = requestedCount || 3;
    return paySlips.slice(0, limit);
  }

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
 * Builds system prompt for Qwen 3.5 AI with local document context.
 */
export function buildPromptContext(userMessage: string, documents: DocumentRecord[]): { system: string; userPrompt: string } {
  const docSummaries = documents.map(d => {
    const sub = d.subcategory ? `${d.category}/${d.subcategory}` : d.category;
    const fType = d.file_type || detectFileType(d.original_filename || d.title);
    return `[Doc #${d.id}] Title: "${d.title}" | Format: ${fType} | Category: ${sub} | Date: ${d.date || 'N/A'} | Amount: ${d.total_amount || 'N/A'}\nSummary: ${d.summary || 'No summary'}`;
  }).join('\n\n');

  const system = `Tu es un assistant archiviste IA local expert pour le tri et la préparation de dossiers administratifs (via outils MCP locaux).
Ta mission est de répondre à la demande de l'utilisateur de manière synthétique et professionnelle en français.

Consignes strictes:
1. Analyse les documents fournis ci-dessous (triés par pertinence et par date via les outils MCP).
2. Sélectionne et liste EXACTEMENT les documents nécessaires qui répondent à la demande.
3. Pour chaque document cité dans ta réponse, mentionne obligatoirement son identifiant sous la forme [Doc #ID: Titre] (exemple: [Doc #1810: Bulletin de Salaire - Décembre 2024]).
4. Si des pièces obligatoires pour le dossier sont absentes de l'archive, indique-les sous "⚠️ Documents manquants suggérés".
5. Réponds directement en texte clair Markdown sans balises JSON raw.`;

  const userPrompt = `Documents disponibles dans la base locale (via MCP):\n${docSummaries || 'Aucun document spécifique trouvé.'}\n\nDemande de l'utilisateur: "${userMessage}"`;

  return { system, userPrompt };
}

/**
 * Main chat handler: processes user query with MCP tool document retrieval & Qwen 3.5 completion.
 */
export async function processChatQuery(userMessage: string, history: ChatMessage[] = []): Promise<ChatResponse> {
  logger.info('CHAT_ASSISTANT', `Processing web chat query via MCP tools: "${userMessage}"`);

  // Execute prepare_dossier MCP tool to retrieve documents
  let matchedDocs: DocumentRecord[] = [];
  try {
    const mcpRes = await handleMcpToolCall('prepare_dossier', { dossierType: userMessage });
    if (mcpRes && mcpRes.content && mcpRes.content[0] && mcpRes.content[0].text) {
      const parsed = JSON.parse(mcpRes.content[0].text);
      if (parsed && Array.isArray(parsed.documents)) {
        matchedDocs = parsed.documents;
      }
    }
  } catch (mcpErr: any) {
    logger.warn('CHAT_ASSISTANT', `MCP prepare_dossier fallback to searchRelevantDocuments: ${mcpErr.message}`);
    matchedDocs = await searchRelevantDocuments(userMessage);
  }

  if (matchedDocs.length === 0) {
    matchedDocs = await searchRelevantDocuments(userMessage);
  }

  const { system, userPrompt } = buildPromptContext(userMessage, matchedDocs);

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

    // Filter matchedDocuments to ONLY return documents cited by AI, or fallback to top candidates
    let finalDocs = matchedDocs;
    if (citedDocIds.size > 0) {
      finalDocs = matchedDocs.filter(d => citedDocIds.has(d.id));
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
