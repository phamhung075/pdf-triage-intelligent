// Table integrity checks for Step C's assembled Markdown.
//
// A GFM row with fewer cells than its header does not leave the trailing column blank — it shifts
// every value one heading to the left. A Bouygues call-detail table came back as
//   | Date | Heure | Numéro appelé | Unité(s) décomptée(s) | Coût € TTC* |
//   | 12/08 | 11:53:37 | 336528710 | 0,00 |
// filing each call's cost under "Unité(s) décomptée(s)" for 33 of 35 rows. That is wrong data, not
// wrong formatting, and nothing in the pipeline noticed: the only way to find it was to audit the
// database afterwards.
//
// This module only MEASURES. It deliberately does not repair: which cell is missing is undecidable
// from the output alone, so padding by guess would assign a figure a meaning the source never gave
// it — precisely what rule 2b of prompts/micro_prompt_markdown.md forbids. Repair belongs to the
// model (rule 2c), and this is the check that says whether the model complied.

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/** Cell count of a GFM row, ignoring the leading and trailing pipes. */
export function countCells(row: string): number {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
}

export interface TableBlockReport {
  /** 0-based line index of the block's first row, for pointing a human at it. */
  startLine: number;
  headerCells: number;
  dataRows: number;
  raggedRows: number;
  hasSeparator: boolean;
}

export interface MarkdownTableReport {
  blocks: number;
  dataRows: number;
  raggedRows: number;
  /** Blocks with no separator row at all — a table continued across a chunk boundary. */
  headerlessBlocks: number;
  worstBlock: TableBlockReport | null;
}

export function auditMarkdownTables(markdown: string): MarkdownTableReport {
  const lines = (markdown || '').split(/\r?\n/);

  // Contiguous runs of pipe rows. A blank line or prose ends a block, which is what separates two
  // genuinely different tables from one table that merely has different column counts.
  const blocks: string[][] = [];
  let current: string[] | null = null;
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line)) {
      if (!current) {
        current = [];
        starts.push(i);
      }
      current.push(line);
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  });
  if (current) blocks.push(current);

  const report: MarkdownTableReport = {
    blocks: blocks.length,
    dataRows: 0,
    raggedRows: 0,
    headerlessBlocks: 0,
    worstBlock: null,
  };

  blocks.forEach((rows, idx) => {
    const separatorIdx = rows.findIndex(r => TABLE_SEPARATOR.test(r));
    if (separatorIdx < 0) {
      report.headerlessBlocks++;
      return; // no header to compare against; the orphan itself is the finding
    }

    const headerCells = countCells(rows[separatorIdx - 1] ?? rows[separatorIdx]);
    let dataRows = 0;
    let raggedRows = 0;
    rows.forEach((row, i) => {
      if (i === separatorIdx || i === separatorIdx - 1) return;
      dataRows++;
      if (countCells(row) !== headerCells) raggedRows++;
    });

    report.dataRows += dataRows;
    report.raggedRows += raggedRows;

    if (raggedRows > 0 && (!report.worstBlock || raggedRows > report.worstBlock.raggedRows)) {
      report.worstBlock = {
        startLine: starts[idx],
        headerCells,
        dataRows,
        raggedRows,
        hasSeparator: true,
      };
    }
  });

  return report;
}

// Content preservation check.
//
// Step C's contract is ZERO CONTENT SKIPPING, but nothing verified it. Bank statements were losing
// transaction payee names — "JEFF DE BRUGES", "BURGER KING", "AUCHAN MARSEILLE" and a
// "SOLDE CREDITEUR" closing balance vanished while every card reference on the same rows survived —
// and the only way to notice was to diff the database by hand.
//
// The measure is token recall: of the distinctive tokens in the raw text (words of 6+ letters and
// numbers, which a summariser drops and markup cannot invent), how many survive into the Markdown?
//
// The blind spot, and why the fusion guard exists: PDF extraction sometimes yields text with no
// spaces at all ("Jemepermetsdevousadressermacandidature"). De-fusing that into real words is a
// legitimate and desirable transformation, but it makes raw tokens unmatchable, scoring ~15% recall
// on a document the pipeline handled *well*. Documents whose raw text is heavily fused are
// therefore not measurable this way and are skipped rather than reported as losses.

// Fusion is detected from three angles because no single one is reliable. Average token length
// alone misses a document like RCHQ_101_..._20100506 — "DateNaturedesoperationsValeurDebitCredit
// 12RUEQUELQUEPART MRNOMPRENOM" scores only 18.9 while being obviously run-together, because the
// surviving spaces drag the mean down. Measured against known-fused and known-clean documents:
//   fused  -> longTokenShare 49-95%, camelShare 10-23%
//   clean  -> longTokenShare  7-20%, camelShare  0-2%   (corpus p90 of longTokenShare is 9.1%)
/** Average characters per whitespace-separated token; above this the text is run-together. */
export const FUSED_TEXT_AVG_WORD_LEN = 25;
/** Share of tokens 15+ chars long. Long account numbers push a clean statement to ~20%. */
export const FUSED_TEXT_LONG_TOKEN_SHARE = 0.35;
/** Share of tokens containing a lowercase->uppercase seam, the signature of glued-together words. */
export const FUSED_TEXT_CAMEL_SHARE = 0.05;

export interface ContentRecallReport {
  /** False when the raw text is too fused for recall to mean anything. */
  measurable: boolean;
  recall: number;
  totalTokens: number;
  missingTokens: number;
  avgWordLength: number;
  /**
   * True when the raw text shows fusion indicators that fell short of the skip thresholds. Recall
   * is then only a HINT: on run-together text, de-fusing and genuine loss are indistinguishable to
   * any token-level measure, so a caller must present the number as something to look at rather
   * than as proof that content was dropped.
   */
  fusionSuspected: boolean;
}

function contentTokens(text: string): string[] {
  return (text || '').toLowerCase().match(/[a-zà-ÿ]{6,}|\d[\d.,]{2,}/g) || [];
}

export function measureContentRecall(rawText: string, markdown: string): ContentRecallReport {
  const trimmed = (rawText || '').trim();
  const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  const words = tokens.length;
  const avgWordLength = words > 0 ? trimmed.length / words : 0;
  const longTokenShare = words > 0 ? tokens.filter(t => t.length >= 15).length / words : 0;
  const camelShare = words > 0 ? tokens.filter(t => /[a-zà-ÿ][A-ZÀ-Ý]/.test(t)).length / words : 0;
  const fused =
    avgWordLength >= FUSED_TEXT_AVG_WORD_LEN ||
    longTokenShare >= FUSED_TEXT_LONG_TOKEN_SHARE ||
    camelShare >= FUSED_TEXT_CAMEL_SHARE;

  const raw = [...new Set(contentTokens(rawText))];
  const md = new Set(contentTokens(markdown));
  // A "missing" token that is itself a fusion artifact is not evidence of loss: the model split it
  // into real words, which is the desired behaviour. Two unambiguous shapes — a run far longer than
  // any ordinary French word ("evolutionsmensuellesdevotrecomptecheques"), and a numeric run
  // carrying several decimal commas ("00,71039,92139,211"), which is multiple amounts glued
  // together and then sliced arbitrarily by the tokenizer.
  const isFusionArtifact = (t: string) => t.length >= 15 || (t.match(/,/g) || []).length >= 2;
  const missing = raw.filter(t => !md.has(t) && !isFusionArtifact(t));

  // Too few tokens to say anything, or text so fused that recall measures de-fusing rather than loss.
  const measurable = raw.length >= 40 && !fused;

  // Below the skip thresholds but still showing fusion: recall is a hint, not a verdict.
  const fusionSuspected =
    !fused && (longTokenShare >= FUSED_TEXT_LONG_TOKEN_SHARE / 3 || camelShare > 0);

  return {
    measurable,
    recall: raw.length > 0 ? (raw.length - missing.length) / raw.length : 1,
    totalTokens: raw.length,
    missingTokens: missing.length,
    avgWordLength,
    fusionSuspected,
  };
}
