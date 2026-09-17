// Docling output gate — decide whether layout-aware Markdown from the Docling extractor is good
// enough to adopt ahead of the normal extraction chain.
//
// WHY THIS GATE EXISTS
// Docling is a second, optional extractor in front of the existing chain (see the DOCLING_SERVICE_*
// settings and extractPDFContent's routing in infrastructure/pdf-extractor.ts). It produces
// structured Markdown with real tables — but its failures are SILENT: measured on the real archive
// (18-doc spike, 2026-09-03), two failure classes returned plausible-looking output with no error:
//   1. Photo-derived single-image PDFs → the layout model labels the whole page one `picture`, OCR
//      text is nested inside it, and the Markdown export collapses to `<!-- image -->` (14 chars).
//   2. Certain native-text PDFs (broken ToUnicode CMaps) → the text layer decodes to garbage
//      (e.g. Hangul syllables on BNP 2018 statements that pypdfium reads cleanly).
// Both would sail past the empty-text "< 10 chars" guard: the first is non-empty but carries no
// text; the second is non-empty, non-corrupted-looking at the mid-word-capitalization detector
// (it is wrong at the CODEPOINT level, not the pattern level), and only a prose-quality check
// rejects it. A whole-page picture output is similarly invisible to corruption heuristics tuned
// for font-CMap damage. So Docling gets its own gate, reusing the calibrated pure signals from
// pdf-text.ts (prose score, corruption) rather than inventing new ones.
//
// THRESHOLDS
// Conservative on purpose — the gate's only job is "is Docling clearly worse than what the normal
// chain produces?" A false rejection just falls back to the existing chain (correct output, one
// wasted HTTP call); a false ACCEPTANCE would silently overwrite good text with Docling garbage.
// The prose-score bar reuses extraction-quality-gate's TEXT_NOISE thresholds, and the content
// gate reuses the "< 10 chars → block" semantics that protect every other extraction path.

import { scoreTextQuality, isLikelyCorruptedText, cleanExtractedText } from './pdf-text.js';
import { auditMarkdownTables, measureContentRecall } from './markdown-tables.js';

export const DOCLING_GATE = {
  /** Prose check reuses the same noise bar as the main quality gate. */
  TEXT_NOISE_MIN_TOKENS: 50,
  TEXT_NOISE_MAX_SCORE: 1.0,
  /** Markdown whose text content is below the global "< 10 chars" floor is unusable. */
  MIN_TEXT_CHARS: 10,
  /** At most this share of a table's data rows may be ragged (cell count ≠ header). */
  MD_MAX_RAGGED_RATIO: 0.5,
  /** Only judged once a table has at least this many data rows. */
  MD_MIN_DATA_ROWS: 6,
} as const;

export interface DoclingQualityMetrics {
  /** Markdown with all image placeholders stripped (the text a reader actually sees). */
  text: string;
  textChars: number;
  textTokens: number;
  /** scoreTextQuality() over the projected text (a real document scores ~4+). */
  proseScore: number;
  corrupted: boolean;
  /** Number of `<!-- image -->` placeholder lines — a pure-picture page has ≥1 and no text. */
  imagePlaceholders: number;
  /** auditMarkdownTables() summary over the Docling markdown. */
  tableBlocks: number;
  dataRows: number;
  raggedRows: number;
}

export interface DoclingQualityFailure {
  /** Stable machine-readable id. */
  id: string;
  message: string;
}

export interface DoclingQualityReport {
  pass: boolean;
  failures: DoclingQualityFailure[];
  metrics: DoclingQualityMetrics;
}

/**
 * Projects Docling Markdown onto plain text for the prose/corruption checks. Kept as a separate
 * export so the gate's judgement is reproducible in tests and in the measurement harness.
 * Markdown *structure* is removed (headings, emphasis, links, pipes, code fences, image
 * placeholders), never document *content*: table pipes become spaces so `| A | B |` reads as
 * words, inline code is unbackticked, and reference-style links keep their label text.
 */
export function projectDoclingMarkdownToText(markdown: string): string {
  if (!markdown) return '';
  const lines = (markdown || '').split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  for (let raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // Image placeholders carry no text — drop the whole line.
    if (/^<!--\s*image\s*-->$/.test(line) || /^!\[[^\]]*\]\([^)]*\)$/.test(line)) continue;
    let t = line
      .replace(/^#{1,6}\s+/, '')           // ATX heading marker
      .replace(/^\s{0,3}>+\s?/, '')         // blockquote
      .replace(/^[-+*]\s+/, '')             // unordered list marker
      .replace(/^\d+[.)]\s+/, '')           // ordered list marker
      .replace(/\|/g, ' ')                  // table pipes -> spaces
      .replace(/`([^`]*)`/g, '$1')          // inline code
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // image with alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
      .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
      .replace(/\s+/g, ' ')
      .trim();
    if (t) out.push(t);
  }
  return out.join('\n');
}

/**
 * Judges whether Docling's Markdown output is good enough to adopt ahead of the normal chain.
 *
 * Fails when (any of):
 *  - the projected text is empty or below the global "< 10 chars" floor (a blank / pure-picture
 *    page — the photo-derived PDF failure class);
 *  - the projected text is nonempty but scores as OCR/decoration noise, not prose (the garbage
 *    text-layer failure class);
 *  - the projected text still shows the mid-word-capitalization corruption symptom;
 *  - a table with enough data rows is majority-ragged (cell count mismatch) — Docling tables are
 *    usually clean, so a majority-ragged one is mis-reconstructed.
 *
 * `rawText` is optional: when the caller has the normal chain's output already (the measurement
 * harness), pass it so a fifth check can reject Docling output that lost the source's content.
 * Production routing (extractPDFContent) does NOT have rawText yet — Docling runs first — so the
 * gate there relies on the four structural checks plus the downstream content-recall audit.
 */
export function assessDoclingMarkdown(markdown: string, rawText?: string): DoclingQualityReport {
  const md = markdown || '';
  const text = projectDoclingMarkdownToText(md);
  const cleaned = cleanExtractedText(text);
  const quality = scoreTextQuality(cleaned);
  const corrupted = isLikelyCorruptedText(cleaned);
  const audit = auditMarkdownTables(md);
  const imagePlaceholders = (md.match(/<!--\s*image\s*-->/g) || []).length;

  const failures: DoclingQualityFailure[] = [];

  if (!cleaned || cleaned.length < DOCLING_GATE.MIN_TEXT_CHARS) {
    failures.push({
      id: 'docling-no-text',
      message: `Docling returned no usable text (${cleaned.length} chars after Markdown projection, ${imagePlaceholders} image placeholder(s)) — a blank page or a whole page classified as one picture.`,
    });
  }
  if (quality.tokens >= DOCLING_GATE.TEXT_NOISE_MIN_TOKENS && quality.score <= DOCLING_GATE.TEXT_NOISE_MAX_SCORE) {
    failures.push({
      id: 'docling-text-noise',
      message: `Docling text looks like OCR/decoration noise, not prose (${quality.tokens} tokens, prose score ${quality.score.toFixed(2)} — a real document scores ~4+).`,
    });
  }
  // Mojibake (broken ToUnicode CMap decoded to the wrong script) is NOT caught by the OCR-noise
  // bar above: its tokens are usually 1-5 syllable characters, so avgTokenLength can sit near or
  // above the prose threshold while the text is still pure garbage. This corpus (FR/EN/VI bank
  // statements, invoices, pay slips) is Latin-script; a decode whose letter tokens are
  // predominantly non-Latin (doc 3/4 of the spike decoded to Hangul syllables) is definitionally a
  // broken CMap, not document content. Conservative: only flags when a big token stream is
  // overwhelmingly non-Latin (>= 80%), so a document that legitimately quotes a few CJK/other
  // characters (names, addresses) never trips it.
  const letters = (cleaned || '').match(/\p{L}+/gu) || [];
  const nonLatinTokens = letters.filter(t => /\p{Script=Latin}/u.test(t) === false).length;
  const nonLatinShare = letters.length > 0 ? nonLatinTokens / letters.length : 0;
  if (
    quality.tokens >= DOCLING_GATE.TEXT_NOISE_MIN_TOKENS &&
    nonLatinShare >= 0.8
  ) {
    failures.push({
      id: 'docling-text-mojibake',
      message: `Docling text decodes to ${quality.tokens} tokens of which ${Math.round(nonLatinShare * 100)}% are non-Latin script (e.g. Hangul/CJK syllables) — a broken text-layer decode (missing ToUnicode CMap), not document content.`,
    });
  }
  if (corrupted) {
    failures.push({
      id: 'docling-text-corrupted',
      message: 'Docling text still shows the mid-word-capitalization corruption symptom of a broken embedded font.',
    });
  }
  const raggedRatio = audit.dataRows > 0 ? audit.raggedRows / audit.dataRows : 0;
  if (audit.dataRows >= DOCLING_GATE.MD_MIN_DATA_ROWS && raggedRatio > DOCLING_GATE.MD_MAX_RAGGED_RATIO) {
    failures.push({
      id: 'docling-ragged-table',
      message: `${audit.raggedRows}/${audit.dataRows} Docling table row(s) (${Math.round(raggedRatio * 100)}%) have a different cell count than their header — values are shifted into the wrong columns.`,
    });
  }
  if (rawText && (rawText || '').trim()) {
    // Content floor vs the source the normal chain reads: Docling must not *lose* tokens the
    // existing extraction found. Measured on the real corpus this is the strongest single signal —
    // clean text-layer docs score 92-99%, OCR-heavy scans 65-85%. measureContentRecall defines
    // its own "measurable" predicate for run-together text and skips unmeasurable input.
    const recall = measureContentRecall(rawText, md);
    if (recall.measurable && recall.recall < 0.55) {
      failures.push({
        id: 'docling-content-loss',
        message: `Only ${Math.round(recall.recall * 100)}% of the source text's distinctive tokens survived into the Docling Markdown (${recall.missingTokens}/${recall.totalTokens} missing) — the structured pass dropped real content.`,
      });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    metrics: {
      text,
      textChars: cleaned.length,
      textTokens: quality.tokens,
      proseScore: quality.score,
      corrupted,
      imagePlaceholders,
      tableBlocks: audit.blocks,
      dataRows: audit.dataRows,
      raggedRows: audit.raggedRows,
    },
  };
}
