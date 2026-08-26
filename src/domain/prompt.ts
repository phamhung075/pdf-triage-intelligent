import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { preprocessRawText, formatLocalDate } from './classification.js';
import { getPromptPersonalization } from '../infrastructure/prompt-personalization-store.js';
import { renderPriorityRulesBlock, renderKnownEntitiesBlock } from './prompt-personalization.js';

function loadPromptPart(filename: string, fallbackDefault: string): string {
  try {
    const filePath = path.join(CONFIG.PROMPTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch (err) {
    console.warn(`Could not load prompt file '${filename}' from ${CONFIG.PROMPTS_DIR}, using fallback:`, err);
  }
  return fallbackDefault.trim();
}

export function buildEntityExtractionPrompt(filename: string, rawText: string): { system: string; user: string } {
  const cleanRawText = preprocessRawText(rawText);
  const textSnippet = cleanRawText.length > 2000 ? cleanRawText.substring(0, 2000) : cleanRawText;
  
  const template = loadPromptPart('micro_prompt_entity.md', `Analyze the following raw document text and filename.
Your ONLY task is to identify:
1. "issuing_entity": The official issuing company, bank, employer, school, hospital, or government organization issuing this document.
   - Ignore employee names, personal customer names, or internal transaction rows!
2. "document_type": The specific type of document (e.g. "Pay Slip", "Bank Statement", "Tax Assessment", "Invoice", "Work Contract", "Identity Document").
{{USER_KNOWN_ENTITIES}}
Filename: {{FILENAME}}

Document Text Snippet:
{{TEXT_SNIPPET}}

Respond ONLY with raw JSON:
{"issuing_entity": "...", "document_type": "..."}`);

  const user = template
    .replace(/\{\{USER_KNOWN_ENTITIES\}\}/g, renderKnownEntitiesBlock(getPromptPersonalization()))
    .replace('{{FILENAME}}', filename)
    .replace('{{TEXT_SNIPPET}}', textSnippet);
  const system = "You are a specialized document entity extraction agent. Respond ONLY in valid JSON.";
  return { system, user };
}

// Emitted by the model (per prompt rule 5 below) when a raw-text fragment is illegible /
// doesn't resolve into coherent words in any language, instead of being fabricated. Exported so
// convertRawTextToZeroLossMarkdown (src/application/classify-document.ts) can detect it in a
// chunk's converted output for debug logging — see docs/agents/classification-expert.md.
export const ILLEGIBLE_FRAGMENT_MARKER = '⚠️ [Illegible fragment — preserved as-is]';

// Minimal cross-chunk continuity context (Problem B — chunk-blind table splitting): when the
// previous chunk's converted Markdown ended mid-table, its detected header + separator row are
// passed here so the next chunk knows to continue the same table instead of re-opening one.
export interface MarkdownContinuationContext {
  header: string;
  separator: string;
}

export function buildMarkdownConversionPrompt(chunkText: string, continuationContext?: MarkdownContinuationContext): { system: string; user: string } {
  const template = loadPromptPart('micro_prompt_markdown.md', `Convert the following raw text chunk into clean, structured GitHub Flavored Markdown (GFM).
STRICT RULES:
1. ZERO CONTENT SKIPPING: Convert 100% of the raw text accurately into Markdown. Do NOT skip, omit, or summarize any words, numbers, amounts, or table rows.
2. TABLES ARE FOR REPEATED ROWS ONLY: Use a GFM Markdown table only for genuinely tabular data with multiple rows sharing the same columns. Do NOT force a one-row table to hold several unrelated fields — list those as separate **Label:** Value lines instead.
3. STRUCTURAL HEADINGS: Use #, ##, ### for headings, and **bold** for key-value labels. This chunk may be a fragment with no visibility into prior chunks (except for any CONTINUATION CONTEXT note below, if present) — keep headings shallow.
4. NO CONVERSATIONAL COMMENTARY: Output ONLY the converted Markdown text.
5. NEVER FABRICATE FROM PATTERN-RECOGNITION: If a fragment of the raw text is illegible or does not resolve into coherent words in ANY language (OCR noise, garbled encoding, random letter fragments), do NOT invent plausible-looking content and do NOT translate or interpret characters you cannot actually make out — even when the fragment's shape pattern-matches a well-known document type you recognize from training (e.g. a Vietnamese balance sheet, a French payslip). Recognizing the document TYPE is not license to fabricate that document type's usual field values. Instead, preserve the illegible fragment near-verbatim, or mark it clearly with a blockquote:
> ${ILLEGIBLE_FRAGMENT_MARKER}
followed by the raw fragment text.
{{CONTINUATION_CONTEXT}}
Raw Text Chunk:
{{CHUNK_TEXT}}`);

  let continuationBlock = '';
  if (continuationContext && continuationContext.header) {
    continuationBlock = `\n⚠️ CONTINUATION CONTEXT: The previous chunk ended mid-table with this open table (header row: "${continuationContext.header}"; column separator: "${continuationContext.separator}"). If this chunk continues the same tabular data, output ONLY the continuing \`| cell | cell |\` rows — do NOT repeat the header/separator row and do NOT start a new table for the same data. If this chunk does not continue that table, ignore this note.\n`;
  }

  const user = template
    .replace('{{CONTINUATION_CONTEXT}}', continuationBlock)
    .replace('{{CHUNK_TEXT}}', chunkText);
  const system = "You are a high-precision document to Markdown converter. Output ONLY valid Markdown with zero skipping.";
  return { system, user };
}

export function buildClassificationPrompt(
  categoriesDescriptionStr: string,
  filename: string,
  rawText: string,
  previousError?: string,
  systemLanguage: 'FR' | 'EN' = 'FR',
  entityHint?: { entity: string; docType?: string },
  now: Date = new Date()
): { system: string; user: string; textSnippetLength: number } {
  const cleanRawText = preprocessRawText(rawText);
  const textSnippet = cleanRawText.length > 4000 ? cleanRawText.substring(0, 4000) + '...' : cleanRawText;

  // markdown_content is no longer requested from this step — Step C (convertRawTextToZeroLossMarkdown)
  // already produces it chunk-by-chunk before this call runs, and Step D regenerating its own copy
  // was pure wasted num_predict budget that was thrown away >50% of the time anyway (see
  // classify-document.ts's former length-comparison guard, now removed).
  const langInstruction = systemLanguage === 'EN'
    ? 'IMPORTANT: Generate the output "titre" and "summary" in English.'
    : 'IMPORTANT: Générez le "titre" et le "summary" en français.';

  const systemHeader = loadPromptPart('system_header.md', '')
    .replace('{{LANG_INSTRUCTION}}', langInstruction)
    .replace('{{CATEGORIES_DESCRIPTION}}', categoriesDescriptionStr);

  const contactRules = loadPromptPart('contact_rules.md', '');
  // classification_rules.md is committed and generic; the personal keyword overrides that used
  // to be hardcoded into its STEP 1/2/5/6/7/10 keyword lists now come from the gitignored
  // .prompts.private.json overlay and are injected as a STEP 0, ahead of the generic flow (a
  // strict-order decision flow means an appended-at-the-end block would never fire for the
  // document types these overrides exist to catch).
  const classificationRules = loadPromptPart('classification_rules.md', '')
    .replace(/\{\{USER_PRIORITY_RULES\}\}/g, renderPriorityRulesBlock(getPromptPersonalization()));
  const formattingRules = loadPromptPart('formatting_rules.md', '')
    .replace(/\{\{CURRENT_DATE\}\}/g, formatLocalDate(now));
  const jsonSchema = loadPromptPart('json_schema_response.json', '');

  const systemTemplate = loadPromptPart(
    'system_template.md',
    '{{SYSTEM_HEADER}}\n\n{{CONTACT_RULES}}\n\n{{CLASSIFICATION_RULES}}\n\n{{FORMATTING_RULES}}\n\nRespond ONLY with raw JSON matching this structure:\n{{JSON_SCHEMA}}'
  );

  const system = systemTemplate
    .replace('{{SYSTEM_HEADER}}', systemHeader)
    .replace('{{CONTACT_RULES}}', contactRules)
    .replace('{{CLASSIFICATION_RULES}}', classificationRules)
    .replace('{{FORMATTING_RULES}}', formattingRules)
    .replace('{{JSON_SCHEMA}}', jsonSchema);

  let retryFeedback = '';
  if (previousError) {
    const retryTemplate = loadPromptPart(
      'retry_prompt.md',
      '\n\n⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):\nThe previous classification attempt for this document encountered an error: "{{PREVIOUS_ERROR}}".\nPlease carefully analyze the document text and fix this issue. You MUST provide a specific, valid Category and Subcategory slug that is genuinely grounded in the Document Text Content (e.g. \'credit_mutuel\', \'impot\', \'ameli\', \'sfr\') — do NOT derive it from the filename. If no real entity is identifiable in the text, it is correct to return \'general\' rather than guessing.'
    );
    retryFeedback = retryTemplate.replace('{{PREVIOUS_ERROR}}', previousError);
  }

  // Step A (buildEntityExtractionPrompt) already ran a dedicated, focused extraction pass over
  // this exact document and identified its issuing entity with higher reliability than asking
  // this single freeform call to both re-derive the entity AND pick the right category in one
  // shot. Without an explicit instruction the model tends to re-analyze from scratch and can
  // still land on a generic fallback category (e.g. 'correspondence') even when hint is correct
  // (this was the root cause of the Crédit Mutuel bank-statement regression — Step A correctly
  // identified the full branch name but Step D still said 'correspondence').
  let entityHintBlock = '';
  if (entityHint && entityHint.entity) {
    entityHintBlock = `\n\n⚠️ PRE-EXTRACTED ENTITY HINT (TREAT AS GROUND TRUTH UNLESS DIRECTLY CONTRADICTED BY THE DOCUMENT TEXT BELOW):\nA dedicated entity-extraction pass already analyzed this exact document and identified the issuing entity as "${entityHint.entity}"${entityHint.docType ? ` (document type: "${entityHint.docType}")` : ''}. Use this identification to choose BOTH the top-level Category and the Subcategory — e.g. if the entity is a bank, Category MUST be 'bank', not a generic fallback like 'correspondence'. Only ignore this hint if the Document Text Content below clearly proves it wrong.`;
  }

  const userTemplate = loadPromptPart(
    'user_template.md',
    'Filename: {{FILENAME}}\n\nDocument Text Content:\n{{TEXT_SNIPPET}}{{RETRY_FEEDBACK}}'
  );

  const user = userTemplate
    .replace('{{FILENAME}}', filename)
    .replace('{{TEXT_SNIPPET}}', textSnippet)
    .replace('{{RETRY_FEEDBACK}}', retryFeedback + entityHintBlock);

  return { system, user, textSnippetLength: textSnippet.length };
}
