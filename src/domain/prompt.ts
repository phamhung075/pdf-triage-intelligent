import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { preprocessRawText } from './classification.js';

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

Filename: {{FILENAME}}

Document Text Snippet:
{{TEXT_SNIPPET}}

Respond ONLY with raw JSON:
{"issuing_entity": "...", "document_type": "..."}`);

  const user = template.replace('{{FILENAME}}', filename).replace('{{TEXT_SNIPPET}}', textSnippet);
  const system = "You are a specialized document entity extraction agent. Respond ONLY in valid JSON.";
  return { system, user };
}

export function buildMarkdownConversionPrompt(chunkText: string): { system: string; user: string } {
  const template = loadPromptPart('micro_prompt_markdown.md', `Convert the following raw text chunk into clean, structured GitHub Flavored Markdown (GFM).
STRICT RULES:
1. ZERO CONTENT SKIPPING: Convert 100% of the raw text accurately into Markdown. Do NOT skip, omit, or summarize any words, numbers, amounts, or table rows.
2. TABLES ARE FOR REPEATED ROWS ONLY: Use a GFM Markdown table only for genuinely tabular data with multiple rows sharing the same columns. Do NOT force a one-row table to hold several unrelated fields — list those as separate **Label:** Value lines instead.
3. STRUCTURAL HEADINGS: Use #, ##, ### for headings, and **bold** for key-value labels. This chunk may be a fragment with no visibility into prior chunks — keep headings shallow.
4. NO CONVERSATIONAL COMMENTARY: Output ONLY the converted Markdown text.

Raw Text Chunk:
{{CHUNK_TEXT}}`);

  const user = template.replace('{{CHUNK_TEXT}}', chunkText);
  const system = "You are a high-precision document to Markdown converter. Output ONLY valid Markdown with zero skipping.";
  return { system, user };
}

export function buildClassificationPrompt(
  categoriesDescriptionStr: string,
  filename: string,
  rawText: string,
  previousError?: string,
  systemLanguage: 'FR' | 'EN' = 'FR',
  entityHint?: { entity: string; docType?: string }
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
  const classificationRules = loadPromptPart('classification_rules.md', '');
  const formattingRules = loadPromptPart('formatting_rules.md', '');
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
