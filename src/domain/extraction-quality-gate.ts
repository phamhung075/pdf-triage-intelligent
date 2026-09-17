// Pre-registration extraction-quality gate + chunk-targeted repair signals.
//
// WHY THIS GATE EXISTS
// The triage pipeline used to register whatever extraction + Step C markdown produced. Doc 5009
// (2026-09-03) showed the failure mode: a table came back with rows outside the GFM pipes (values
// dropping out of the table entirely) and the pipeline stored it with no error anywhere — the
// integrity audit only sees lines that START with '|', so the malformed rows were invisible.
//
// WHY TWO LAYERS
// 1. While Step C converts, each chunk's output is screened (assessChunkMarkdown /
//    describeTableRepairNote). A chunk whose output has malformed table rows or an absurd column
//    blow-out is re-converted ONCE, alone, with a corrective note — the failing chunk is repaired,
//    the other chunks' output is untouched. Re-running the whole document would waste the model
//    round-trips of every chunk that converted fine, and would re-roll the dice on the healthy ones.
// 2. Before registration (in triage-scan, after classification), the COMPLETE document is assessed
//    (assessExtractionQuality). A hard failure throws ExtractionQualityGateError — a typed,
//    catchable error (mirroring OllamaUnavailableError) so a programmatic caller — the web scan
//    route, an MCP tool, or a local agent that wants to re-fix the file directly — can act on the
//    structured report instead of parsing log lines.
//
// Every threshold is deliberately CONSERVATIVE. The gate exists to stop *obviously unusable*
// content from entering the registry (where it silently corrupts FTS search, summaries and the
// chat assistant), not to reject documents with cosmetic quirks. Thresholds are calibrated on the
// real corpus (recent docs 4991-5009): healthy documents pass with margin, the known-bad shapes
// fail.

import { auditMarkdownTables, measureContentRecall, countCells } from './markdown-tables.js';
import { isLikelyCorruptedText, scoreTextQuality } from './pdf-text.js';

export const QUALITY_GATE = {
  /** Text-noise check: ignore short docs; flag prose-quality scores at/below this. */
  TEXT_NOISE_MIN_TOKENS: 50,
  TEXT_NOISE_MAX_SCORE: 1.0,
  /** Malformed pipe rows (a line holding `|` cells but not a well-formed GFM row). */
  MD_MALFORMED_MIN_LINES: 4,
  /** Integrity audit: absolute ragged rows OR a large share of a big-enough table. */
  MD_RAGGED_MIN_ROWS: 4,
  MD_RAGGED_MIN_DATA_ROWS: 6,
  MD_RAGGED_MAX_RATIO: 0.5,
  /** Orphan table fragments with no header (tables that never re-joined across chunk boundaries). */
  MD_HEADERLESS_MIN_BLOCKS: 2,
  /** Distinctive-token recall floor when the text is measurable (see measureContentRecall). */
  MD_CONTENT_RECALL_MIN: 0.55,
  /** A header this wide is a chart/axis blow-out, not a data table (see neutralizeChartLikeTables). */
  CHUNK_WIDE_HEADER_COLS: 14,
} as const;

export interface QualityGateMetrics {
  textTokens: number;
  textScore: number;
  textCorrupted: boolean;
  tableBlocks: number;
  dataRows: number;
  raggedRows: number;
  headerlessBlocks: number;
  malformedPipeLines: number;
  contentRecall: number | null;
}

export interface QualityGateFailure {
  /** Stable machine-readable id (used in blocked-file records and by agents). */
  id: string;
  message: string;
}

export interface QualityGateReport {
  pass: boolean;
  failures: QualityGateFailure[];
  metrics: QualityGateMetrics;
}

/**
 * Counts lines that clearly came from (or should be inside) a GFM table but are not well-formed
 * table rows — e.g. doc 5009's `Base - 03kVA - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0%`
 * (pipe cells but no leading/trailing pipe) and `**Relevé fin**: Conso kWh | Prix €HT/kWh | ...`
 * (markup glued into a header). auditMarkdownTables() cannot see these, yet each one is a row
 * whose values are about to drop out of the table.
 */
export function countMalformedPipeLines(markdown: string): number {
  const lines = (markdown || '').split(/\r?\n/);
  return lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^\|.*\|\s*$/.test(trimmed)) return false; // well-formed GFM row
    if (/^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(trimmed)) return false; // separator row
    const pipes = (trimmed.match(/\|/g) || []).length;
    return pipes >= 2;
  }).length;
}

/**
 * First example lines of a chunk's malformed output, for the corrective note sent back to the
 * model (short — never the whole chunk).
 */
export function malformedPipeExamples(markdown: string, max = 2): string[] {
  const lines = (markdown || '').split(/\r?\n/);
  const seen: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\|.*\|\s*$/.test(trimmed)) continue;
    if ((trimmed.match(/\|/g) || []).length >= 2) {
      seen.push(trimmed.length > 70 ? `${trimmed.slice(0, 70)}…` : trimmed);
      if (seen.length >= max) break;
    }
  }
  return seen;
}

/** Largest header width among well-formed table blocks (0 when none). */
export function widestTableHeader(markdown: string): number {
  const lines = (markdown || '').split(/\r?\n/);
  let widest = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(line)) continue; // separator row below a header
    const header = i > 0 ? lines[i - 1].trim() : '';
    if (!/^\|.*\|\s*$/.test(header)) continue;
    const cells = countCells(header);
    if (cells > widest) widest = cells;
  }
  return widest;
}

export interface ChunkMarkdownReport {
  malformedPipeLines: number;
  malformedExamples: string[];
  widestTableHeader: number;
}

/** Per-chunk structural screen run as each chunk converts (cheap, no document context needed). */
export function assessChunkMarkdown(markdown: string): ChunkMarkdownReport {
  return {
    malformedPipeLines: countMalformedPipeLines(markdown),
    malformedExamples: malformedPipeExamples(markdown),
    widestTableHeader: widestTableHeader(markdown),
  };
}

/**
 * Builds the corrective note for a chunk whose output failed the structural screen. Returns null
 * when the chunk output is structurally fine (nothing to repair). This note is the single source
 * of truth for both the per-chunk retry and the human/agent message.
 */
export function describeTableRepairNote(markdown: string): string | null {
  const report = assessChunkMarkdown(markdown);
  const parts: string[] = [];
  if (report.malformedPipeLines > 0) {
    const examples = report.malformedExamples.length > 0
      ? `, e.g. \`${report.malformedExamples.join('` / `')}\``
      : '';
    parts.push(
      `${report.malformedPipeLines} line(s) carry table cells but are NOT well-formed GFM rows${examples}. ` +
      'Every row of a table must start with `|`, end with `|`, and have EXACTLY as many cells as its header. ' +
      'Do not merge separate columns into one cell and do not leave a column label dangling inside a bold line.'
    );
  }
  if (report.widestTableHeader >= QUALITY_GATE.CHUNK_WIDE_HEADER_COLS) {
    parts.push(
      `A table header has ${report.widestTableHeader} columns — that is a chart axis or decorative row, not data. ` +
      'Do NOT emit it as a table; keep its labels as plain text lines.'
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export function assessExtractionQuality(rawText: string, markdown: string): QualityGateReport {
  const raw = rawText || '';
  const md = markdown || '';

  const textQuality = scoreTextQuality(raw);
  const textCorrupted = isLikelyCorruptedText(raw);
  const audit = auditMarkdownTables(md);
  const recall = measureContentRecall(raw, md);
  const malformedPipeLines = countMalformedPipeLines(md);

  const failures: QualityGateFailure[] = [];

  if (textQuality.tokens >= QUALITY_GATE.TEXT_NOISE_MIN_TOKENS && textQuality.score <= QUALITY_GATE.TEXT_NOISE_MAX_SCORE) {
    failures.push({
      id: 'text-ocr-noise',
      message: `Extracted text looks like OCR/decoration noise, not words (${textQuality.tokens} tokens, prose score ${textQuality.score.toFixed(2)} — a real document scores ~4+).`,
    });
  }
  if (textCorrupted) {
    failures.push({
      id: 'text-still-corrupted',
      message: 'Extracted text still shows the mid-word-capitalization corruption symptom of a broken embedded font (ToUnicode CMap).',
    });
  }
  if (malformedPipeLines >= QUALITY_GATE.MD_MALFORMED_MIN_LINES) {
    const examples = malformedPipeExamples(md);
    failures.push({
      id: 'markdown-malformed-rows',
      message: `${malformedPipeLines} line(s) carry table cells but are not well-formed GFM rows — their values drop out of the table${examples.length > 0 ? ` (e.g. \`${examples.join('` / `')}\`)` : ''}.`,
    });
  }
  const raggedRatio = audit.dataRows > 0 ? audit.raggedRows / audit.dataRows : 0;
  if (
    audit.raggedRows >= QUALITY_GATE.MD_RAGGED_MIN_ROWS ||
    (audit.dataRows >= QUALITY_GATE.MD_RAGGED_MIN_DATA_ROWS && raggedRatio >= QUALITY_GATE.MD_RAGGED_MAX_RATIO)
  ) {
    failures.push({
      id: 'markdown-ragged-table',
      message: `${audit.raggedRows}/${audit.dataRows} table row(s) (${Math.round(raggedRatio * 100)}%) have a different cell count than their header — values are shifted into the wrong columns.`,
    });
  }
  if (audit.headerlessBlocks >= QUALITY_GATE.MD_HEADERLESS_MIN_BLOCKS) {
    failures.push({
      id: 'markdown-headerless-table',
      message: `${audit.headerlessBlocks} table block(s) have no header at all (tables that never re-joined across chunk boundaries).`,
    });
  }
  if (recall.measurable && recall.recall < QUALITY_GATE.MD_CONTENT_RECALL_MIN) {
    failures.push({
      id: 'markdown-content-loss',
      message: `Only ${Math.round(recall.recall * 100)}% of the distinctive source tokens survived into the markdown (${recall.missingTokens}/${recall.totalTokens} missing) — values present in the source are absent from the output.`,
    });
  }

  return {
    pass: failures.length === 0,
    failures,
    metrics: {
      textTokens: textQuality.tokens,
      textScore: textQuality.score,
      textCorrupted,
      tableBlocks: audit.blocks,
      dataRows: audit.dataRows,
      raggedRows: audit.raggedRows,
      headerlessBlocks: audit.headerlessBlocks,
      malformedPipeLines,
      contentRecall: recall.measurable ? recall.recall : null,
    },
  };
}

/**
 * Thrown when the full-document quality gate fails AFTER the automatic single-chunk repair pass.
 * A programmatic caller (web scan route, MCP tool, or a local agent re-fixing the source file
 * directly) can catch it and act on `report.failures` / `metrics`.
 */
export class ExtractionQualityGateError extends Error {
  readonly report: QualityGateReport;
  readonly filename: string;

  constructor(filename: string, report: QualityGateReport) {
    const details = report.failures.map(f => `- ${f.id}: ${f.message}`).join('\n');
    super(
      `⛔ Quality gate blocked '${filename}' before registration (${report.failures.length} issue(s)) after automatic single-chunk repair:\n${details}\n` +
      `Re-fix this file locally (extraction quality, OCR or markdown of the offending chunk) and re-scan.`
    );
    this.name = 'ExtractionQualityGateError';
    this.filename = filename;
    this.report = report;
  }
}
