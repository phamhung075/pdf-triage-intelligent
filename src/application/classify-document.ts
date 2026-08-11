import { CONFIG } from '../infrastructure/settings.js';
import { DocumentMetadataSchema, DocumentMetadata } from '../domain/document.schema.js';
import { logger } from '../infrastructure/logger.js';
import { cleanAndParseJSON, ruleBasedClassify, buildCategoriesDescriptionStr } from '../domain/classification.js';
import { buildClassificationPrompt, buildEntityExtractionPrompt, buildMarkdownConversionPrompt } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory, applyEntityPriorityOverride } from '../domain/classification-resolution.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { ensureOllamaModel, requestClassificationCompletion, requestTextChatCompletion } from '../infrastructure/ollama-client.js';

// Condenses a model's chain-of-thought / reasoning text for structured logging — long enough to
// be useful when tracing a bad decision later, short enough not to flood logs/triage_debug.log.
function truncateForLog(text: string | undefined | null, maxLen = 400): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '…' : trimmed;
}

export function chunkText(rawText: string, maxChunkSize = 1400): string[] {
  if (!rawText || rawText.length <= maxChunkSize) {
    return [rawText || ''];
  }

  const chunks: string[] = [];
  const lines = rawText.split(/\r?\n/);
  let currentChunk = '';

  for (const line of lines) {
    if ((currentChunk.length + line.length + 1) > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += line + '\n';
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export async function convertRawTextToZeroLossMarkdown(rawText: string, filename?: string): Promise<string> {
  const chunks = chunkText(rawText, 1400);
  const convertedChunks: string[] = [];
  let successCount = 0;
  let fallbackCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const { system, user } = buildMarkdownConversionPrompt(chunk);
      // Step C converts raw text into free-form GFM Markdown (headers, tables, bold) — not JSON.
      // requestClassificationCompletion forces format:'json' grammar-constrained decoding, which
      // starves/garbles Markdown output and was silently degrading most chunks to the raw-text
      // fallback below. requestTextChatCompletion has no format constraint.
      const res = await requestTextChatCompletion(system, user);
      const mdSnippet = res.response.trim();
      if (mdSnippet && mdSnippet.length > 10) {
        convertedChunks.push(mdSnippet);
        successCount++;
      } else {
        convertedChunks.push(chunk);
        fallbackCount++;
        logger.debug('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} returned empty/too-short markdown, keeping raw text chunk`, { filename });
      }
    } catch (err: any) {
      fallbackCount++;
      logger.debug('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} conversion failed (${err.message}), keeping raw text chunk`, { filename });
    }
  }

  // Per-step decision logging (finding E): lets a human later see, without re-running anything,
  // how much of a document's markdown came from the model vs the raw-text fallback.
  logger.info('OLLAMA_AI', `[STEP C] Markdown conversion complete for '${filename || 'document'}': ${successCount}/${chunks.length} chunk(s) converted, ${fallbackCount}/${chunks.length} kept as raw-text fallback`, {
    filename, totalChunks: chunks.length, successCount, fallbackCount
  });

  return convertedChunks.join('\n\n');
}

export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

  const categoriesConfig = getCategoriesConfig();
  const dictionary = getEntityDictionary();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig, dictionary);

  let validated: DocumentMetadata;
  let decisionMethod = 'Modular Ollama AI Pipeline — Step A (entity) + Step C (markdown) + Step D (classification), qwen3.5:9b';
  let decisionReason = 'Analyzed via Step A entity extraction + Step C markdown conversion + Step D classification';
  let extractedEntity = '';
  let extractedDocType = '';

  try {
    if (!modelHealthy) {
      throw new Error(`Model '${CONFIG.OLLAMA_MODEL}' failed capability check — skipping LLM request.`);
    }

    // Step A: Dedicated Primary Entity & Document Type Extractor. Failures here are non-fatal —
    // Step D still runs (without the hint) rather than falling all the way back to the
    // rule-based classifier just because this narrow, best-effort pass didn't parse.
    try {
      const { system: sysA, user: usrA } = buildEntityExtractionPrompt(filename, rawText);
      const resA = await requestClassificationCompletion(sysA, usrA);
      const parsedA = cleanAndParseJSON(resA.response.trim());

      extractedEntity = parsedA.issuing_entity || parsedA.entity_name || '';
      extractedDocType = parsedA.document_type || parsedA.doc_type || '';
      logger.info('OLLAMA_AI', `[STEP A] Detected Entity: "${extractedEntity}", DocType: "${extractedDocType}" for ${filename}`, {
        filename, extractedEntity, extractedDocType, thinking: truncateForLog(resA.thinking)
      });
    } catch (err: any) {
      logger.debug('OLLAMA_AI', `[STEP A] Entity extraction skipped for ${filename}: ${err.message}`, { filename });
    }

    // Step C: Chunk-by-Chunk Zero-Loss Markdown Conversion
    let fullMarkdownContent = rawText;
    if (rawText.trim().length > 0) {
      logger.info('OLLAMA_AI', `[STEP C] Converting raw text (${rawText.length} chars) to Markdown chunk-by-chunk for ${filename}...`, { filename });
      fullMarkdownContent = await convertRawTextToZeroLossMarkdown(rawText, filename);
    }

    // Step D: Classification + Executive Summary + structured metadata, using the clean Step C
    // markdown as input, with Step A's entity/doc-type passed as an explicit, prioritized hint
    // (see buildClassificationPrompt's entityHint block) rather than an easily-ignored bracket note.
    const { system: sysD, user: usrD } = buildClassificationPrompt(
      categoriesDescriptionStr, filename, fullMarkdownContent, previousError, CONFIG.LANGUAGE,
      extractedEntity ? { entity: extractedEntity, docType: extractedDocType } : undefined
    );

    const resD = await requestClassificationCompletion(sysD, usrD);
    const parsedD = cleanAndParseJSON(resD.response.trim());
    validated = DocumentMetadataSchema.parse(parsedD);

    // markdown_content is no longer requested from Step D (see prompt.ts/json_schema_response.json) —
    // Step C's chunk-by-chunk conversion is always the source of truth, so it's applied unconditionally
    // instead of the former "keep Step D's copy unless it's under 50% of Step C's length" comparison,
    // which spent Step D's num_predict budget on markdown that was thrown away most of the time anyway.
    validated.markdown_content = fullMarkdownContent;

    logger.info('OLLAMA_AI', `[STEP D] Raw classification from Ollama for ${filename}: categorie="${parsedD.categorie}", subcategorie="${parsedD.subcategorie}"`, {
      filename, rawCategorie: parsedD.categorie, rawSubcategorie: parsedD.subcategorie,
      thinking: truncateForLog(resD.thinking || parsedD.thinking)
    });

    // Entity-priority override (finding A): when Step A's entity is grounded in the curated
    // entity_dictionary.json and Step D fell back to a generic category, trust the grounded
    // entity over Step D's freeform guess — see classification-resolution.ts for why this is
    // scoped to "weak fallback" categories only.
    let entityPriorityApplied = false;
    if (extractedEntity) {
      const override = applyEntityPriorityOverride(validated, extractedEntity, dictionary);
      if (override.overridden) {
        entityPriorityApplied = true;
        logger.info('OLLAMA_AI', `[STEP A PRIORITY] ${override.reason}`, {
          filename, from: `${validated.categorie}/${validated.subcategorie}`, to: `${override.categorie}/${override.subcategorie}`
        });
        validated.categorie = override.categorie;
        validated.subcategorie = override.subcategorie;
        decisionReason = `Step D classified as ${parsedD.categorie}/${parsedD.subcategorie}, but overridden by Step A entity priority: ${override.reason}`;
      }
    }

    if (!entityPriorityApplied) {
      decisionReason = `Step D classified document as ${validated.categorie}/${validated.subcategorie} (Step A entity: ${extractedEntity || 'N/A'})`;
    }

  } catch (err: any) {
    decisionMethod = 'Rule-Based Pattern Classifier';
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    decisionReason = `Rule-Based fallback: ${rb.reason}`;
    logger.warn('OLLAMA_AI', `Ollama AI request failed for ${filename}: ${err.message}. ${decisionReason}`);
    validated = DocumentMetadataSchema.parse({
      titre: rb.title,
      registre: '',
      date: rb.date,
      categorie: rb.categorie,
      subcategorie: rb.subcategorie,
      summary: `Document: ${rb.title}. ${decisionReason}`,
      tags: [rb.categorie, rb.subcategorie].filter(Boolean),
      markdown_content: `# ${rb.title}\n\n${rawText}`
    });
  }

  validated = refineClassification(validated, rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);

  const { category: matchedCategory, isNew: isNewCategory } = resolveCategory(categoriesConfig, validated.categorie);
  if (isNewCategory) {
    logger.info('OLLAMA_AI', `Auto-created new category '${matchedCategory.id}' for ${filename} BEFORE move`);
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  const { subcategoryId, isNew: isNewSubcategory, rawSubSlug } = resolveSubcategory(matchedCategory, validated.subcategorie, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST);
  if (isNewSubcategory) {
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${subcategoryId}' under '${matchedCategory.id}' BEFORE move`, { filename });
    saveCategoriesConfig(categoriesConfig.categories);
    validated.subcategorie = subcategoryId;
  } else if (subcategoryId === 'general' && validated.subcategorie !== 'general') {
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug '${rawSubSlug}' for ${filename} (not found in document content) — trying rule-based fallback`);
    const rbFallback = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    if (rbFallback.subcategorie && rbFallback.subcategorie !== 'general') {
      validated.categorie = rbFallback.categorie;
      validated.subcategorie = rbFallback.subcategorie;
      decisionReason += ` | Rule fallback override: ${rbFallback.reason}`;
    } else if (validated.categorie === 'bulletin_salaire') {
      validated.subcategorie = 'bulletin_salaire';
    } else {
      validated.subcategorie = 'general';
    }
  } else {
    validated.subcategorie = subcategoryId;
  }

  logger.info('CLASSIFIER_DECISION', `[DECISION LOGIC] '${filename}' ➔ '${validated.categorie}/${validated.subcategorie}'`, {
    filename,
    method: decisionMethod,
    reason: decisionReason,
    title: validated.titre,
    category: validated.categorie,
    subcategory: validated.subcategorie,
    date: validated.date,
    extractedEntity: extractedEntity || undefined,
    extractedDocType: extractedDocType || undefined,
    // The model's own self-reported reasoning for this classification, when it filled the
    // "thinking" field in its JSON response (see prompts/json_schema_response.json) — distinct
    // from Ollama's out-of-band response.thinking, which is intentionally disabled via
    // think:false (see ollama-client.ts) so the model's whole answer doesn't route there instead
    // of response.response.
    thinking: truncateForLog(validated.thinking)
  });

  return validated;
}
