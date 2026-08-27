import { CONFIG } from '../infrastructure/settings.js';
import { DocumentMetadataSchema, DocumentMetadata } from '../domain/document.schema.js';
import { logger } from '../infrastructure/logger.js';
import { cleanAndParseJSON, ruleBasedClassify, buildCategoriesDescriptionStr, reconcileDocumentDate } from '../domain/classification.js';
import { buildClassificationPrompt, buildEntityExtractionPrompt, buildMarkdownConversionPrompt, ILLEGIBLE_FRAGMENT_MARKER, MarkdownContinuationContext } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory, applyEntityPriorityOverride } from '../domain/classification-resolution.js';
import { auditMarkdownTables, measureContentRecall } from '../domain/markdown-tables.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { getPromptPersonalization } from '../infrastructure/prompt-personalization-store.js';
import { recordTaxonomyHint } from '../infrastructure/taxonomy-hints-store.js';
import { ensureOllamaModel, requestClassificationCompletion, requestTextChatCompletion } from '../infrastructure/ollama-client.js';

// Condenses a model's chain-of-thought / reasoning text for structured logging — long enough to
// be useful when tracing a bad decision later, short enough not to flood logs/triage_debug.log.
function truncateForLog(text: string | undefined | null, maxLen = 400): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '…' : trimmed;
}

// A line longer than the whole chunk budget used to be appended whole, so the "chunk" it produced
// blew straight past maxChunkSize. That is not hypothetical: an archived tax declaration extracted
// to 590,166 chars across just 320 lines — 153 of them over 1400 chars, the longest 13,860 — and
// the resulting ~14k-char chunk went to a model whose num_predict caps the RESPONSE at 4096 tokens.
// The reply came back truncated but non-empty and passed the `length > 10` success gate as
// "converted". (An earlier version of this comment claimed that had left the document's markdown at
// "6% of its raw text" — that ratio turned out to be a whitespace artefact, since these PDFs extract
// to text that is 92-99% whitespace. The over-long chunk is still a real bug; the 6% was not
// evidence of it.) Splitting on whitespace keeps words intact; an unbroken run with no whitespace is
// hard-cut, because exceeding the budget is worse than an ugly seam.
function splitOverlongLine(line: string, maxChunkSize: number): string[] {
  const pieces: string[] = [];
  let rest = line;

  while (rest.length > maxChunkSize) {
    let cut = rest.lastIndexOf(' ', maxChunkSize);
    // Ignore a boundary so early that the piece would be mostly empty (and guarantee progress:
    // cut must always be > 0, or this loop would never terminate).
    if (cut < maxChunkSize / 2) cut = maxChunkSize;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ +/, '');
  }

  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

export function chunkText(rawText: string, maxChunkSize = 1400): string[] {
  if (!rawText || rawText.length <= maxChunkSize) {
    return [rawText || ''];
  }

  const chunks: string[] = [];
  const lines = rawText.split(/\r?\n/).flatMap(line =>
    line.length > maxChunkSize ? splitOverlongLine(line, maxChunkSize) : [line]
  );
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

// Below this share of distinctive raw tokens surviving, the conversion has dropped real content.
// Set from the archive's own distribution: median recall is ~95%, and the documents with verified
// losses (bank statements missing payee names) sit at 53-69%. 0.80 flags those without firing on
// ordinary documents.
const CONTENT_RECALL_WARN_THRESHOLD = 0.80;

const TABLE_ROW_PATTERN = /^\|.*\|\s*$/;
// A GFM header-separator row: every cell is only dashes/colons/whitespace, e.g. `| --- | :--- |`.
const TABLE_SEPARATOR_PATTERN = /^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

// Problem B (chunk-blind table splitting): detects whether a chunk's converted Markdown output
// ends "mid-table" — i.e. its last non-blank line is a GFM table data row with a header +
// separator row above it in the same chunk. When found, that header/separator is threaded into
// the next chunk's prompt as continuation context (see MarkdownContinuationContext in prompt.ts)
// so the model continues the same table instead of opening a disconnected new one.
export function detectOpenTableTail(markdown: string): MarkdownContinuationContext | null {
  const lines = markdown.split(/\r?\n/);

  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0) return null;

  const lastLine = lines[end].trim();
  if (!TABLE_ROW_PATTERN.test(lastLine) || TABLE_SEPARATOR_PATTERN.test(lastLine)) return null;

  // Walk upward through the contiguous run of table rows looking for the separator row.
  let i = end;
  let separatorIdx = -1;
  while (i >= 0 && TABLE_ROW_PATTERN.test(lines[i].trim())) {
    if (TABLE_SEPARATOR_PATTERN.test(lines[i].trim())) {
      separatorIdx = i;
      break;
    }
    i--;
  }
  if (separatorIdx <= 0) return null; // no separator found, or nothing above it to be the header

  const header = lines[separatorIdx - 1].trim();
  const separator = lines[separatorIdx].trim();
  if (!TABLE_ROW_PATTERN.test(header)) return null;

  return { header, separator };
}

export async function convertRawTextToZeroLossMarkdown(rawText: string, filename?: string): Promise<string> {
  const chunks = chunkText(rawText, 1400);
  const convertedChunks: string[] = [];
  let successCount = 0;
  let fallbackCount = 0;
  let pendingContinuation: MarkdownContinuationContext | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const { system, user } = buildMarkdownConversionPrompt(chunk, pendingContinuation);
      // Step C converts raw text into free-form GFM Markdown (headers, tables, bold) — not JSON.
      // requestClassificationCompletion forces format:'json' grammar-constrained decoding, which
      // starves/garbles Markdown output and was silently degrading most chunks to the raw-text
      // fallback below. requestTextChatCompletion has no format constraint.
      const res = await requestTextChatCompletion(system, user);
      const mdSnippet = res.response.trim();
      // done_reason 'length' means generation stopped at num_predict, not because the model was
      // finished — the markdown is cut off mid-document. It is still long and plausible-looking, so
      // the length check below would happily accept it and drop whatever came after the cut. The
      // raw chunk is worse-formatted but complete, and completeness is Step C's actual contract.
      if (res.doneReason === 'length') {
        convertedChunks.push(chunk);
        fallbackCount++;
        pendingContinuation = undefined;
        logger.warn('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} hit the model's output limit (done_reason=length) — its markdown was truncated mid-chunk, keeping raw text instead`, { filename, chunkIndex: i + 1, totalChunks: chunks.length, chunkChars: chunk.length, truncatedChars: mdSnippet.length });
        continue;
      }
      if (mdSnippet && mdSnippet.length > 10) {
        convertedChunks.push(mdSnippet);
        successCount++;

        if (mdSnippet.includes(ILLEGIBLE_FRAGMENT_MARKER)) {
          logger.info('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} output contains an illegible-fragment marker (preserved instead of fabricated)`, { filename, chunkIndex: i + 1, totalChunks: chunks.length });
        }

        const openTail = i < chunks.length - 1 ? detectOpenTableTail(mdSnippet) : null;
        if (openTail) {
          logger.debug('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} ends mid-table — passing continuation context (header: "${openTail.header}") to chunk ${i + 2}`, { filename, chunkIndex: i + 1, nextChunkIndex: i + 2, detectedHeader: openTail.header });
          pendingContinuation = openTail;
        } else {
          pendingContinuation = undefined;
        }
      } else {
        convertedChunks.push(chunk);
        fallbackCount++;
        pendingContinuation = undefined;
        logger.warn('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} returned empty/too-short markdown, keeping raw text chunk`, { filename, chunkIndex: i + 1, totalChunks: chunks.length });
      }
    } catch (err: any) {
      // The push is the whole point of this branch: Step C's contract with the model is ZERO
      // CONTENT SKIPPING (prompts/micro_prompt_markdown.md rule 1), so a chunk the model could not
      // convert must still reach the output as raw text. Omitting it here silently deleted the
      // chunk from markdown_content — the caller sees a shorter document and no error at all.
      convertedChunks.push(chunk);
      fallbackCount++;
      pendingContinuation = undefined;
      logger.warn('OLLAMA_AI', `[STEP C] Chunk ${i + 1}/${chunks.length} conversion failed (${err.message}), keeping raw text chunk`, { filename, chunkIndex: i + 1, totalChunks: chunks.length, error: err.message });
    }
  }

  // Per-step decision logging (finding E): lets a human later see, without re-running anything,
  // how much of a document's markdown came from the model vs the raw-text fallback.
  logger.info('OLLAMA_AI', `[STEP C] Markdown conversion complete for '${filename || 'document'}': ${successCount}/${chunks.length} chunk(s) converted, ${fallbackCount}/${chunks.length} kept as raw-text fallback`, {
    filename, totalChunks: chunks.length, successCount, fallbackCount
  });

  // Table integrity is checked on the ASSEMBLED markdown, not per chunk, because a table split
  // across a chunk boundary is only visible once the pieces are joined. Measured, never repaired:
  // a row short of the header has shifted its values one column left, and which cell went missing
  // cannot be recovered from the output, so guessing would give a figure a meaning the source never
  // gave it. Without this line the damage was invisible — the only way to find it was to audit the
  // database after the fact, which is how the Bouygues call-detail tables were caught filing each
  // call's cost under "Unité(s) décomptée(s)".
  const assembled = convertedChunks.join('\n\n');
  const tables = auditMarkdownTables(assembled);
  if (tables.raggedRows > 0 || tables.headerlessBlocks > 0) {
    // Only state the symptoms that actually occurred. The two are independent — a document can have
    // headerless blocks and no ragged rows — and an earlier version always led with the ragged
    // clause, so a document with 0 ragged rows was told "those rows' values are shifted into the
    // wrong columns" about no rows at all. A warning that overstates what it found is a warning
    // people learn to skim past.
    const parts: string[] = [];
    if (tables.raggedRows > 0) {
      const pct = tables.dataRows > 0 ? Math.round((100 * tables.raggedRows) / tables.dataRows) : 0;
      parts.push(`${tables.raggedRows}/${tables.dataRows} data row(s) (${pct}%) have a different cell count than their header, so those rows' values are shifted into the wrong columns`);
    }
    if (tables.headerlessBlocks > 0) {
      parts.push(`${tables.headerlessBlocks} table block(s) have no header at all (a table split across a chunk boundary)`);
    }
    logger.warn(
      'OLLAMA_AI',
      `[STEP C] Table integrity problems in '${filename || 'document'}': ${parts.join('; ')}`,
      {
        filename,
        tableBlocks: tables.blocks,
        dataRows: tables.dataRows,
        raggedRows: tables.raggedRows,
        headerlessBlocks: tables.headerlessBlocks,
        worstBlockLine: tables.worstBlock?.startLine,
        worstBlockHeaderCells: tables.worstBlock?.headerCells,
      }
    );
  }

  // Step C's contract is ZERO CONTENT SKIPPING; this is the only thing that checks it. Bank
  // statements were dropping transaction payee names and a closing balance while every card
  // reference on the same rows survived, and nothing anywhere said so. Skipped for heavily fused
  // raw text, where unmatchable raw tokens mean the model de-fused correctly rather than lost
  // anything — see measureContentRecall.
  const recall = measureContentRecall(rawText, assembled);
  if (recall.measurable && recall.recall < CONTENT_RECALL_WARN_THRESHOLD && recall.fusionSuspected) {
    // Fused source text: de-fusing and genuine loss are indistinguishable to any token measure, so
    // this cannot be asserted. It stays at DEBUG rather than becoming a WARN nobody can act on —
    // a family of BNP RLV_CHQ_* statements produced ~10 such warnings an hour, every one a false
    // alarm on markdown that was correct. Still recorded, so an audit can find it.
    logger.debug('OLLAMA_AI', `[STEP C] Low token recall for '${filename || 'document'}' (${(recall.recall * 100).toFixed(0)}%), but the raw text is run-together — most likely the model split fused words correctly rather than dropping content`, {
      filename, recallPct: Math.round(recall.recall * 100), missingTokens: recall.missingTokens, totalTokens: recall.totalTokens, fusionSuspected: true,
    });
  } else if (recall.measurable && recall.recall < CONTENT_RECALL_WARN_THRESHOLD) {
    logger.warn(
      'OLLAMA_AI',
      `[STEP C] Content preservation below threshold for '${filename || 'document'}': ${(recall.recall * 100).toFixed(0)}% of distinctive raw-text tokens survived into the markdown (${recall.missingTokens}/${recall.totalTokens} missing) — values present in the source are absent from markdown_content`,
      {
        filename,
        recallPct: Math.round(recall.recall * 100),
        missingTokens: recall.missingTokens,
        totalTokens: recall.totalTokens,
        fusionSuspected: recall.fusionSuspected,
      }
    );
  }

  return assembled;
}

export async function classifyPDFText(rawText: string, filename: string, previousError?: string, now: Date = new Date()): Promise<DocumentMetadata> {
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

  const categoriesConfig = getCategoriesConfig();
  const dictionary = getEntityDictionary();
  // rawText, not the Step C markdown: the filter only needs to know which entities this document
  // mentions, and rawText is available before Step C runs.
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig, dictionary, rawText);

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
      extractedEntity ? { entity: extractedEntity, docType: extractedDocType } : undefined,
      now
    );

    const resD = await requestClassificationCompletion(sysD, usrD);
    const parsedD = cleanAndParseJSON(resD.response.trim());
    validated = DocumentMetadataSchema.parse(parsedD);

    // Defense-in-depth: Step D can still mis-derive a future date from an OCR-garbled two-digit
    // year even with the CURRENT_DATE guard in the prompt (see formatting_rules.md) — catch it
    // here against the titre's own stated year before it corrupts date-based sorting downstream.
    const dateReconciliation = reconcileDocumentDate(validated.date, validated.titre, now);
    if (dateReconciliation.corrected) {
      logger.warn('OLLAMA_AI', `[STEP D] Corrected future-dated "date" field for ${filename}: ${dateReconciliation.reason}`, {
        filename, originalDate: validated.date, correctedDate: dateReconciliation.date
      });
      validated.date = dateReconciliation.date;
    }

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
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST, getPromptPersonalization());
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

  // The raw values the model proposed — kept BEFORE resolution so the duplicate guard can record
  // exactly what was blocked and what it was mapped onto (the hint that teaches future runs).
  const proposedCategory = validated.categorie;
  const proposedSubcategory = validated.subcategorie;

  const { category: matchedCategory, isNew: isNewCategory, conflict: categoryConflict } = resolveCategory(categoriesConfig, proposedCategory, proposedSubcategory);
  if (categoryConflict) {
    // BLOCK: never auto-create a near-duplicate top-level category or an entity-as-category
    // (e.g. 'administratif' -> 'administrative', 'france_travail' as a category). Remap to the
    // existing entry and record a hint so future runs stop proposing it.
    logger.warn('TAXONOMY_GUARD', `[BLOCKED] ${categoryConflict.hint}`, { filename, proposedCategory, proposedSubcategory });
    recordTaxonomyHint({
      proposed_category: proposedCategory,
      proposed_subcategory: proposedSubcategory,
      mapped_category: categoryConflict.mappedCategoryId,
      mapped_subcategory: categoryConflict.mappedSubcategoryId,
      hint: categoryConflict.hint,
    });
    decisionReason += ` | Taxonomy duplicate guard: ${categoryConflict.hint}`;
  }
  if (isNewCategory) {
    logger.info('OLLAMA_AI', `Auto-created new category '${matchedCategory.id}' for ${filename} BEFORE move`);
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  const { subcategoryId, isNew: isNewSubcategory, rawSubSlug, conflict: subcategoryConflict } = resolveSubcategory(matchedCategory, proposedSubcategory, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST, categoriesConfig);
  if (subcategoryConflict) {
    // BLOCK: the slug already exists elsewhere in the taxonomy (exact, alias or near-duplicate
    // spelling). Never create a second instance — reuse the existing slug, and when it lives
    // under another category, re-file the document there (one-instance-per-subcategory).
    logger.warn('TAXONOMY_GUARD', `[BLOCKED] ${subcategoryConflict.hint}`, { filename, proposedCategory, proposedSubcategory });
    recordTaxonomyHint({
      proposed_category: proposedCategory,
      proposed_subcategory: proposedSubcategory,
      mapped_category: subcategoryConflict.mappedCategoryId,
      mapped_subcategory: subcategoryConflict.mappedSubcategoryId,
      hint: subcategoryConflict.hint,
    });
    decisionReason += ` | Taxonomy duplicate guard: ${subcategoryConflict.hint}`;
    if (subcategoryConflict.mappedCategoryId !== matchedCategory.id) {
      validated.categorie = subcategoryConflict.mappedCategoryId;
    }
  }
  if (isNewSubcategory) {
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${subcategoryId}' under '${matchedCategory.id}' BEFORE move`, { filename });
    saveCategoriesConfig(categoriesConfig.categories);
    validated.subcategorie = subcategoryId;
  } else if (subcategoryId === 'general' && validated.subcategorie !== 'general') {
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug '${rawSubSlug}' for ${filename} (not found in document content) — trying rule-based fallback`);
    const rbFallback = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST, getPromptPersonalization());
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
