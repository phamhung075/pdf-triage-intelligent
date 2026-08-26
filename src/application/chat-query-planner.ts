import {
  StructuredQuerySchema,
  buildFtsMatchExpression,
  planQueryHeuristic,
  type StructuredQuery,
} from '../domain/chat-query.js';
import { cleanAndParseJSON, formatLocalDate } from '../domain/classification.js';
import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { getCategoriesConfig } from '../infrastructure/categories-store.js';
import { logger } from '../infrastructure/logger.js';

/**
 * Builds the planner prompt. The category list is a parameter, read from the live taxonomy by the
 * caller — never a literal here. Committed prompts stay free of personal entities (Golden Rule);
 * the model learns real names from the taxonomy at runtime, not from this file.
 */
export function buildPlannerPrompt(
  userMessage: string,
  categoryIds: string[],
  now: Date
): { system: string; userPrompt: string } {
  const system = `Tu convertis une demande de document en requête de recherche structurée JSON.
Tu ne réponds JAMAIS à la demande — tu produis UNIQUEMENT l'objet JSON.

Nous sommes le ${formatLocalDate(now)}. Résous toute expression temporelle relative
("les 3 derniers mois", "cette année", "l'an dernier") en dates ISO à partir de cette date.

Catégories disponibles: ${categoryIds.join(', ')}.

Renvoie exactement cet objet:
{
  "docTypes": [],   // le TYPE de document demandé, avec ses synonymes usuels et son sigle.
                    // Ex: pour un RIB -> ["rib", "relevé d'identité bancaire", "iban", "bic"]
  "entities":  [],  // l'organisme / l'émetteur cité, avec ses variantes et abréviations
  "keywords":  [],  // les autres termes porteurs de sens (jamais de mots vides)
  "notTerms":  [],  // les types de documents à EXCLURE quand ils se confondent avec la demande.
                    // Ex: pour un RIB -> ["relevé de compte", "mouvement"]
  "category":  null,        // une des catégories ci-dessus, ou null
  "subcategory": null,
  "dateFrom":  null,        // "YYYY-MM-DD" ou null
  "dateTo":    null,
  "limit":     null         // nombre de documents demandé, ou null
}

Règles:
- Mets des SYNONYMES dans docTypes: c'est ce qui rattrape un document mal titré.
- notTerms est ce qui sépare deux documents du même organisme. Utilise-le.
- N'invente pas de catégorie absente de la liste. Dans le doute, null.
- Aucun texte hors du JSON.`;

  return { system, userPrompt: `Demande: "${userMessage}"` };
}

/**
 * Turns a free-text request into a StructuredQuery.
 *
 * Never throws and never returns an unusable plan: any failure — Ollama down, prose instead of
 * JSON, valid JSON with nothing searchable in it — degrades to the deterministic heuristic
 * planner, so the chat keeps working without a model.
 */
export async function planQuery(userMessage: string, now: Date = new Date()): Promise<StructuredQuery> {
  const fallback = () => planQueryHeuristic(userMessage);

  try {
    const categoryIds = getCategoriesConfig().categories.map(c => c.id);
    const { system, userPrompt } = buildPlannerPrompt(userMessage, categoryIds, now);
    const { response } = await requestTextChatCompletion(system, userPrompt);

    const plan = StructuredQuerySchema.parse(cleanAndParseJSON(response ?? ''));
    if (buildFtsMatchExpression(plan) === null) {
      logger.warn('CHAT_PLANNER', 'Model plan had no searchable facet; using heuristic planner.');
      return fallback();
    }
    return plan;
  } catch (err: any) {
    logger.warn('CHAT_PLANNER', `Planner failed (${err?.message}); using heuristic planner.`);
    return fallback();
  }
}
