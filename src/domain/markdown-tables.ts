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

// Chart/axis regions are not tables.
//
// When OCR or a confused markdown pass renders a bar chart's axis labels as a GFM table, the block
// has a huge header (one cell per bar/month) and near-empty data rows — doc 5009's
// "Evolution de votre consommation" chart came back as a 64-column table whose only data row was
// entirely empty cells. Nothing flagged it: the cells matched the header count, so the integrity
// audit above measures it as healthy. No document in this archive's use (invoices, payslips, bank
// statements, tax forms) needs 14+ columns, so a block whose header claims that many cells is
// definitionally not tabular data.
//
// auditMarkdownTables() only MEASURES, on purpose: repair belongs to the model because guessing
// which cell belongs where can fabricate data. This neutralizer is different — it changes nothing
// about the content, it only removes the TABLE STRUCTURE from a shape that never was one. Every
// cell is kept verbatim inside a blockquote (so auditMarkdownTables no longer counts it as a
// ragged/healthy table, and markdown renderers no longer draw a giant empty grid), and the whole
// block stays in markdown_content for FTS/search.
export const CHART_TABLE_MAX_HEADER_CELLS = 14;

export interface ChartLikeNeutralizeReport {
  markdown: string;
  /** How many table blocks were converted to verbatim blockquotes. */
  neutralizedBlocks: number;
  /** How many pipe rows were converted (for the log line). */
  neutralizedLines: number;
}

export function neutralizeChartLikeTables(markdown: string): ChartLikeNeutralizeReport {
  const report: ChartLikeNeutralizeReport = { markdown: markdown || '', neutralizedBlocks: 0, neutralizedLines: 0 };
  const lines = (markdown || '').split(/\r?\n/);
  if (lines.length === 0) return report;

  // Same contiguous-run detection as auditMarkdownTables: a run of pipe rows is one block.
  const blocks: { start: number; rows: string[] }[] = [];
  let current: string[] | null = null;
  let start = -1;
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line)) {
      if (!current) {
        current = [];
        start = i;
      }
      current.push(line);
    } else if (current) {
      blocks.push({ start, rows: current });
      current = null;
    }
  });
  if (current) blocks.push({ start, rows: current });

  const out: string[] = [...lines];
  // Convert from the last block backwards so earlier block line indices stay valid.
  for (const block of [...blocks].reverse()) {
    const separatorIdx = block.rows.findIndex(r => TABLE_SEPARATOR.test(r));
    if (separatorIdx < 0) continue; // no header → nothing to compare (headerless is audited separately)
    const headerCells = countCells(block.rows[separatorIdx - 1] ?? block.rows[separatorIdx]);
    if (headerCells < CHART_TABLE_MAX_HEADER_CELLS) continue;

    const marker = `> ⚠️ [Wide non-tabular region (${headerCells} columns) — kept verbatim as text, not a data table]`;
    out.splice(block.start, 0, marker);
    // Prefixed AFTER the marker insert so earlier rows still map 1:1 onto their block rows.
    const insertAt = block.start + 1;
    block.rows.forEach((row, rowOffset) => {
      out[insertAt + rowOffset] = `> ${row}`;
    });
    report.neutralizedBlocks += 1;
    report.neutralizedLines += block.rows.length;
  }

  report.markdown = out.join('\n');
  return report;
}

// Well-formedness repair: table rows that lost their edge pipes.
//
// The model occasionally emits a table whose rows carry the cell pipes but drop the leading or
// trailing pipe — doc 5009's "Base - 03kVA - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0%".
// Such a line is invisible to auditMarkdownTables (it only counts rows that START with '|'), so
// the whole row silently leaves the table. This pass re-inserts ONLY the missing edge pipes —
// adding "| " at the start and " |" at the end is a purely syntactic, reversible change that
// cannot fabricate or move a value, unlike the width repairs the model itself must make. Lines
// that are markup or prose (headings, blockquotes, lists, bold labels) are never touched.
export interface PipeRowNormalizeReport {
  markdown: string;
  /** How many rows got their missing edge pipes back. */
  fixedLines: number;
}

const PIPE_MARKUP_PREFIX = /^[>#*+\-]|^\d+\./;

export function normalizeMalformedPipeRows(markdown: string): PipeRowNormalizeReport {
  const out = (markdown || '').split(/\r?\n/);
  let fixedLines = 0;
  for (let i = 0; i < out.length; i++) {
    const trimmed = out[i].trim();
    if (!trimmed) continue;
    if (/^\|.*\|\s*$/.test(trimmed)) continue; // already a well-formed GFM row
    if (/^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(trimmed)) continue; // separator
    if (PIPE_MARKUP_PREFIX.test(trimmed)) continue; // heading / blockquote / list / bold label
    const pipes = (trimmed.match(/\|/g) || []).length;
    if (pipes < 2) continue;
    let fixed = trimmed.startsWith('|') ? trimmed : `| ${trimmed}`;
    if (!fixed.endsWith('|')) fixed += ' |';
    out[i] = fixed;
    fixedLines++;
  }
  return { markdown: out.join('\n'), fixedLines };
}
// Headerless continuation rows: merge them back into the table they belong to.
//
// Chunk boundaries split tables: the model continues a table across chunks by emitting ONLY the
// continuing `| row |` lines (no header — see the CONTINUATION CONTEXT note), and joinChunkMarkdown
// already avoids a blank line when the previous chunk's LAST line is a row. But a model that adds
// a trailing heading/text after its rows (or the raw-text fallback of a chunk) leaves the next
// chunk's rows separated by a blank line — a new "headerless" block containing rows whose header
// lives in the previous block. Rows like that are perfectly good data, just visually orphaned.
// When a headerless block DIRECTLY follows (blank-lines only between them) a table block whose
// header has the SAME column count, re-join them: the rows continue that table. Width must match
// exactly — a different width means a different table and is left alone.
export interface OrphanBlockMergeReport {
  markdown: string;
  mergedBlocks: number;
}

export function mergeHeaderlessContinuationBlocks(markdown: string): OrphanBlockMergeReport {
  const lines = (markdown || '').split(/\r?\n/);
  // Identify contiguous runs of pipe rows (blocks) and which have a header separator.
  const blocks: { start: number; rows: string[] }[] = [];
  let current: string[] | null = null;
  let start = -1;
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line)) {
      if (!current) {
        current = [];
        start = i;
      }
      current.push(line);
    } else if (current) {
      blocks.push({ start, rows: current });
      current = null;
    }
  });
  if (current) blocks.push({ start, rows: current });

  const headerCellsOf = (b: { rows: string[] }): number | null => {
    const sepIdx = b.rows.findIndex(r => TABLE_SEPARATOR.test(r));
    if (sepIdx < 0) return null;
    return countCells(b.rows[sepIdx - 1] ?? b.rows[sepIdx]);
  };
  const onlyBlankBetween = (aEnd: number, bStart: number): boolean => {
    for (let i = aEnd + 1; i < bStart; i++) {
      if (lines[i].trim() !== '') return false;
    }
    return true;
  };

  const merges = new Set<number>(); // indexes of headerless blocks that get merged into the previous one
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    const prevCells = headerCellsOf(prev);
    const curHasHeader = headerCellsOf(cur) !== null;
    if (curHasHeader || prevCells === null) continue;
    if (countCells(cur.rows[0]) !== prevCells) continue;
    if (!onlyBlankBetween(prev.start + prev.rows.length - 1, cur.start)) continue;
    merges.add(i);
  }
  if (merges.size === 0) return { markdown: markdown || '', mergedBlocks: 0 };

  // Rebuild: drop the blank lines between merged pairs by removing the lines between the blocks.
  const dropFrom = new Set<number>();
  for (const i of merges) {
    const prevEnd = blocks[i - 1].start + blocks[i - 1].rows.length - 1;
    for (let j = prevEnd + 1; j < blocks[i].start; j++) dropFrom.add(j);
  }
  const out = lines.filter((_, idx) => !dropFrom.has(idx));
  return { markdown: out.join('\n'), mergedBlocks: merges.size };
}
// Heading-split table rows: a row whose FIRST CELL escaped to a heading.
//
// A table split across a chunk boundary is usually continued as bare `| row |` lines (see the
// continuation context), but when prose — a footnote, a caption — sits between the chunks' rows,
// the model sometimes promotes each continuation row's first cell to a Markdown heading instead:
//   ## Base - 03kVA - du 01/02/26 au 16/05/26
//   | 9,16 | 31,62 | 20,0% |
// The passes above cannot see this damage: the value line is already a well-formed GFM row (edge
// pipes intact) whose width is one short of the header, so the orphan-merge pass refuses it, and
// the row now lives in a headerless block below a heading — doc 5009's "Grille tarifaire" came
// back exactly this way, 3 of its rows promoted to headings with their values left behind.
//
// The parent table is not always healthy either: on some runs the model ALSO dropped the leading
// header cell ("| Prix €HT/mois | Montant €HTTVA | TVA |" with no "Période" column), so its own
// rows are one cell wider than its header. A fold must then match the DATA width, not the header —
// otherwise the repair silently skips the very escape it exists for.
//
// This repair is deterministic and content-preserving: when a heading is IMMEDIATELY followed by a
// lone well-formed row, every cell of that row is a pure value (numeric/percent/€ — a description
// cell would carry words), and the nearest headed table above is exactly (row width + 1) columns
// wide — measured against the block's uniform data width when that is wider than its header — the
// heading text is that row's missing first cell. Re-fold it and move the row into the parent table
// so description and values are one row again. The gates are deliberately narrow — width match,
// all-numeric cells, a lone row, no intervening headed table, a bounded gap — so a heading that
// merely introduces its own small table, or sits far from any table, is left alone.
export interface HeadingSplitRowReport {
  markdown: string;
  /** How many heading-promoted rows were re-folded into their parent table. */
  reattachedRows: number;
}

const HEADING_LINE = /^#{1,6}\s+\S/;
/** A pure value cell (FR/EN number, optional €/% or a parenthesized footnote ref) — never prose. */
const VALUE_CELL = /^[-–—−]?\s*\(?\d[\d\s.,\u00A0€%]*(?:\)\s*)?$/;
/** Maximum non-blank lines of prose allowed between a table and its escaped rows (a footnote). */
const HEADING_SPLIT_MAX_GAP_LINES = 8;

export function reattachHeadingSplitTableRows(markdown: string): HeadingSplitRowReport {
  const lines = (markdown || '').split(/\r?\n/);
  if (lines.length === 0) return { markdown: markdown || '', reattachedRows: 0 };

  // Pipe blocks (same contiguous-run detection as the audit) with their header width and, when the
  // block's data rows all share one width, that uniform data width.
  const blocks: {
    start: number;
    end: number;
    headerCells: number | null;
    dataWidth: number | null;
  }[] = [];
  let current: { start: number; rows: string[] } | null = null;
  const pushBlock = () => {
    if (!current) return;
    const sep = current.rows.findIndex(r => TABLE_SEPARATOR.test(r));
    let headerCells: number | null = null;
    let dataWidth: number | null = null;
    if (sep >= 0) {
      headerCells = countCells(current.rows[sep - 1] ?? current.rows[sep]);
      const widths = current.rows
        .filter((_, i) => i !== sep && i !== sep - 1)
        .map(row => countCells(row));
      if (widths.length > 0 && widths.every(w => w === widths[0])) dataWidth = widths[0];
    }
    blocks.push({
      start: current.start,
      end: current.start + current.rows.length - 1,
      headerCells,
      dataWidth,
    });
    current = null;
  };
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line)) {
      if (!current) current = { start: i, rows: [] };
      current.rows.push(line);
    } else {
      pushBlock();
    }
  });
  pushBlock();

  // Nearest headed table block ending above a given line (orphan headerless row blocks in between
  // are skipped — they are earlier escapes, not a real parent).
  const parentBlockAbove = (
    lineIdx: number
  ): { end: number; headerCells: number; dataWidth: number | null } | null => {
    for (let b = blocks.length - 1; b >= 0; b--) {
      if (blocks[b].end >= lineIdx) continue;
      if (blocks[b].headerCells === null) continue;
      return {
        end: blocks[b].end,
        headerCells: blocks[b].headerCells as number,
        dataWidth: blocks[b].dataWidth,
      };
    }
    return null;
  };
  const nextNonBlank = (from: number): number => {
    for (let i = from; i < lines.length; i++) if (lines[i].trim() !== '') return i;
    return -1;
  };

  const deleteLines = new Set<number>();
  const insertAfter: Map<number, string[]> = new Map(); // parent block last line -> folded rows

  for (let h = 0; h < lines.length; h++) {
    const heading = lines[h].trim();
    if (!HEADING_LINE.test(heading)) continue;

    const r = nextNonBlank(h + 1);
    if (r < 0 || deleteLines.has(r)) continue;
    const row = lines[r].trim();
    if (!TABLE_ROW.test(row) || TABLE_SEPARATOR.test(row)) continue;

    // The row must stand ALONE: a heading followed by several rows (or a row with more rows after
    // it) is a section title above its own small table, not a stolen first cell.
    const after = nextNonBlank(r + 1);
    if (after >= 0 && TABLE_ROW.test(lines[after].trim())) continue;

    const rowCells = row.replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (rowCells.length < 2) continue;
    if (!rowCells.every(c => VALUE_CELL.test(c.trim()))) continue;

    const parent = parentBlockAbove(h);
    if (!parent) continue;
    // Fold width must equal the parent's real column count. Prefer the block's uniform DATA width
    // when it is wider than the header — that is the signature of a run whose header lost its
    // leading label cell ("Prix €HT/mois | ..." under rows that carry a description column) — and
    // fall back to the header width otherwise.
    const want =
      parent.dataWidth !== null && parent.dataWidth > parent.headerCells
        ? parent.dataWidth
        : parent.headerCells;
    if (rowCells.length + 1 !== want) continue;

    // The heading must sit near its table: a lone numeric row under a matching-width table found
    // hundreds of lines away is more likely an unrelated caption than an escaped row.
    let gapLines = 0;
    for (let i = parent.end + 1; i < h; i++) if (lines[i].trim() !== '') gapLines++;
    if (gapLines > HEADING_SPLIT_MAX_GAP_LINES) continue;

    const desc = heading.replace(/^#{1,6}\s+/, '').trim().replace(/\s+/g, ' ');
    if (!desc || desc.endsWith(':')) continue;

    const restored = `| ${desc} | ${rowCells.map(c => c.trim()).join(' | ')} |`;
    deleteLines.add(h);
    deleteLines.add(r);
    const bucket = insertAfter.get(parent.end);
    if (bucket) bucket.push(restored);
    else insertAfter.set(parent.end, [restored]);
  }

  if (insertAfter.size === 0) return { markdown: markdown || '', reattachedRows: 0 };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (deleteLines.has(i)) continue;
    out.push(lines[i]);
    const appended = insertAfter.get(i);
    if (appended) out.push(...appended);
  }
  return {
    markdown: out.join('\n'),
    reattachedRows: [...insertAfter.values()].reduce((n, rows) => n + rows.length, 0),
  };
}

// Table headers one cell short of every one of their rows: restore the missing leading cell.
//
// The heading-reattach pass above folds escaped rows into a parent whose DATA width is wider than
// its header — but the header stays short, so the whole block still audits as ragged
// ("values shifted into the wrong columns") even though every value now sits under the right
// column. The same short-header state occurs without any heading escape: on some runs doc 5009's
// Grille tarifaire came back as ONE block whose header was "| Prix €HT/mois | Montant €HTTVA |
// TVA |" (the model dropped the leading "Période" column) while every data row still carried its
// description cell — a 4-cell row under a 3-cell header. Nothing folds there, so only this pass
// can see it.
//
// Signature: a headed block whose data rows are ALL exactly one cell wider than their header,
// whose last cell (every row) is a pure value, and whose FIRST cell (every row) is NOT a value —
// a descriptive/period label column that lost its header cell. The label itself is not derivable
// deterministically from the output (the model itself is inconsistent about it between runs), so
// the restored cell is EMPTY: width integrity is restored — the audit sees one healthy table and
// no value is ever shifted, invented or relabelled — and the column is self-describing from its
// rows. Blocks whose rows are ragged in any other way, or whose extra width comes from trailing
// junk, are left alone.
export interface HeaderRestoreReport {
  markdown: string;
  /** How many table headers were given back their missing leading cell. */
  restoredHeaders: number;
}

/** Rebuild a GFM row with one EMPTY cell prepended (header and separator alignment only). */
function prependEmptyCell(row: string): string {
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  return `|  | ${cells.join(' | ')} |`;
}

export function restoreMissingTableHeaderCells(markdown: string): HeaderRestoreReport {
  const lines = (markdown || '').split(/\r?\n/);
  if (lines.length === 0) return { markdown: markdown || '', restoredHeaders: 0 };

  const blocks: { start: number; rows: string[]; sep: number }[] = [];
  let current: { start: number; rows: string[] } | null = null;
  const pushBlock = () => {
    if (!current) return;
    const sep = current.rows.findIndex(r => TABLE_SEPARATOR.test(r));
    if (sep >= 0) blocks.push({ start: current.start, rows: current.rows, sep });
    current = null;
  };
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line)) {
      if (!current) current = { start: i, rows: [] };
      current.rows.push(line);
    } else {
      pushBlock();
    }
  });
  pushBlock();

  const padLine = new Set<number>(); // line indexes of header/separator rows to pad
  for (const block of blocks) {
    const { sep } = block;
    const headerCells = countCells(block.rows[sep - 1] ?? block.rows[sep]);
    if (headerCells < 2) continue;
    const dataRows = block.rows.filter((_, i) => i !== sep && i !== sep - 1);
    if (dataRows.length === 0) continue;

    // Every data row exactly one cell wider than the header…
    if (!dataRows.every(row => countCells(row) === headerCells + 1)) continue;
    // …with the extra width on the LEFT (descriptive first cells, pure-value last cells). A block
    // whose rows are one cell wider because of trailing filler is a different damage, not this one.
    const firstCells = dataRows.map(row =>
      (row.trim().replace(/^\|/, '').split('|')[0] ?? '').trim()
    );
    const lastCells = dataRows.map(row => {
      const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      return (cells[cells.length - 1] ?? '').trim();
    });
    if (!lastCells.every(c => VALUE_CELL.test(c))) continue;
    if (!firstCells.every(c => !VALUE_CELL.test(c))) continue;

    padLine.add(block.start + sep - 1); // header row (always exists above a separator)
    padLine.add(block.start + sep); // separator row, kept aligned with the padded header
  }

  if (padLine.size === 0) return { markdown: markdown || '', restoredHeaders: 0 };
  const out = [...lines];
  for (const i of padLine) out[i] = prependEmptyCell(out[i]);
  return { markdown: out.join('\n'), restoredHeaders: padLine.size / 2 };
}