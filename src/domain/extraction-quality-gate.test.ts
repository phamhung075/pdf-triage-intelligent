import { describe, it, expect } from 'vitest';
import {
  assessExtractionQuality,
  assessChunkMarkdown,
  countMalformedPipeLines,
  describeTableRepairNote,
  ExtractionQualityGateError,
  widestTableHeader,
  QUALITY_GATE,
} from './extraction-quality-gate.js';

const CLEAN_PROSE =
  'Bonjour Mademoiselle Palma, vous avez choisi la mensualisation pour régler vos factures ' +
  'électricité et vous trouverez ci-joint votre facture de régularisation ainsi que votre bilan ' +
  'personnalisé. Le montant total de votre facture correspond à la différence entre les montants ' +
  'facturés et les prélèvements déjà effectués sur votre compte sur la période concernée.';

const PROPER_TABLE = [
  '| Période | Prix | Montant | TVA |',
  '| --- | --- | --- | --- |',
  '| Base - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
  '| Base - du 01/08/25 au 31/01/26 | 8,51 | 51,48 | 20,0% |',
].join('\n');

// The doc-5009 shape: rows that carry `|` cells but have no leading/trailing pipe.
const MALFORMED_ROWS_MD = [
  '## Détail de la facture',
  '',
  '| Période | Prix | Montant | TVA |',
  '| --- | --- | --- | --- |',
  '| Base - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
  'Base - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0%',
  'Base - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0%',
  'Base - du 01/08/25 au 31/01/26 | 8,51 | 51,48 | 20,0%',
  '**Relevé fin**: Conso kWh | Prix €HT/kWh | Montant €HTTVA',
].join('\n');

// Unique 6-letter content tokens ("mot" + a 3-letter base-26 encoding of the index) — long enough
// for measureContentRecall's tokenizer, short enough to never look fused.
function word(i: number): string {
  return 'mot' +
    String.fromCharCode(97 + (i % 26)) +
    String.fromCharCode(97 + (Math.floor(i / 26) % 26)) +
    String.fromCharCode(97 + (Math.floor(i / 676) % 26));
}
function manyTokens(n: number): string {
  return Array.from({ length: n }, (_, i) => word(i)).join(' ');
}

describe('countMalformedPipeLines', () => {
  it('counts doc-5009-style rows that carry cells but are not well-formed GFM rows', () => {
    expect(countMalformedPipeLines(MALFORMED_ROWS_MD)).toBe(4);
  });

  it('ignores well-formed rows, separator rows and prose without pipes', () => {
    expect(countMalformedPipeLines(PROPER_TABLE)).toBe(0);
    expect(countMalformedPipeLines('Just some prose without any pipes.')).toBe(0);
    expect(countMalformedPipeLines('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(0);
  });
});

describe('assessChunkMarkdown / describeTableRepairNote', () => {
  it('describes malformed rows so the retry prompt can correct them', () => {
    const note = describeTableRepairNote(MALFORMED_ROWS_MD);
    expect(note).toContain('NOT well-formed GFM rows');
    expect(note).toContain('Base - du 01/02/26 au 16/05/26');
    expect(note).toContain('start with `|`');
  });

  it('returns null for structurally clean chunk output', () => {
    expect(describeTableRepairNote(PROPER_TABLE)).toBeNull();
    expect(describeTableRepairNote('# Heading\n\nSome prose.')).toBeNull();
  });

  it('flags a chart/axis header blow-out as not-a-table', () => {
    const wide = `| ${Array.from({ length: 30 }, (_, i) => `c${i}`).join(' | ')} |\n| ${Array.from({ length: 30 }, () => '---').join(' | ')} |`;
    expect(widestTableHeader(wide)).toBe(30);
    expect(describeTableRepairNote(wide)).toContain('chart axis');
  });

  it('exposes per-chunk metrics', () => {
    const report = assessChunkMarkdown(MALFORMED_ROWS_MD);
    expect(report.malformedPipeLines).toBe(4);
    expect(report.malformedExamples.length).toBeGreaterThan(0);
  });
});

describe('assessExtractionQuality', () => {
  it('passes healthy text with a well-formed table', () => {
    const report = assessExtractionQuality(CLEAN_PROSE, `${CLEAN_PROSE}\n\n${PROPER_TABLE}`);
    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('flags pure OCR/decoration noise text', () => {
    const noise = Array.from({ length: 60 }, () => 'S').join(' ');
    const report = assessExtractionQuality(noise, '');
    expect(report.pass).toBe(false);
    expect(report.failures.map(f => f.id)).toContain('text-ocr-noise');
  });

  it('flags markdown whose table rows are malformed (doc-5009 gate case)', () => {
    const report = assessExtractionQuality(CLEAN_PROSE, MALFORMED_ROWS_MD);
    expect(report.pass).toBe(false);
    const ids = report.failures.map(f => f.id);
    expect(ids).toContain('markdown-malformed-rows');
  });

  it('flags a table whose rows are ragged against their header', () => {
    const md = [
      '| Date | Heure | Numéro | Coût |',
      '| --- | --- | --- | --- |',
      '| 12/08 | 11:53 | 0612345678 | 0,00 |',
      '| 13/08 | 12:01 | 0612345679 | 1,00 |',
      '| 14/08 | 09:00 | 0612345680 |',
      '| 15/08 | 10:00 | 0612345681 |',
      '| 16/08 | 11:00 | 0612345682 |',
      '| 17/08 | 12:00 | 0612345683 |',
    ].join('\n');
    const report = assessExtractionQuality(CLEAN_PROSE, md);
    expect(report.pass).toBe(false);
    expect(report.failures.map(f => f.id)).toContain('markdown-ragged-table');
  });

  it('flags orphan table blocks that lost their header across chunks', () => {
    const md = [
      '| 12/08 | 11:53 | 0,00 |',
      '| 13/08 | 12:01 | 0,00 |',
      '',
      '| 14/08 | 09:00 | 0,00 |',
      '| 15/08 | 10:00 | 0,00 |',
    ].join('\n');
    const report = assessExtractionQuality(CLEAN_PROSE, md);
    expect(report.pass).toBe(false);
    expect(report.failures.map(f => f.id)).toContain('markdown-headerless-table');
  });

  it('flags heavy content loss into the markdown', () => {
    // 80 distinctive source tokens, only the first 40 of which survive into the markdown.
    const report = assessExtractionQuality(manyTokens(80), manyTokens(40));
    expect(report.metrics.contentRecall).not.toBeNull();
    expect(report.pass).toBe(false);
    expect(report.failures.map(f => f.id)).toContain('markdown-content-loss');
  });

  it('flags text that is still mid-word-capitalization corrupted', () => {
    const filler = Array.from({ length: 120 }, (_, i) => `mot${i % 7}`).join(' ');
    const corrupt = `${filler} ${Array.from({ length: 12 }, (_, i) => `kA${i}`).join(' ')}`;
    const report = assessExtractionQuality(corrupt, '');
    expect(report.pass).toBe(false);
    expect(report.failures.map(f => f.id)).toContain('text-still-corrupted');
  });

  it('remembers the malformed-row threshold for future calibration', () => {
    expect(QUALITY_GATE.MD_MALFORMED_MIN_LINES).toBeGreaterThanOrEqual(1);
  });
});

describe('ExtractionQualityGateError', () => {
  it('carries the structured report and a direct re-fix hint for agents', () => {
    const report = assessExtractionQuality(CLEAN_PROSE, MALFORMED_ROWS_MD);
    const err = new ExtractionQualityGateError('facture.pdf', report);
    expect(err).toBeInstanceOf(Error);
    expect(err.filename).toBe('facture.pdf');
    expect(err.report.pass).toBe(false);
    expect(err.report.failures.length).toBeGreaterThan(0);
    expect(err.message).toContain('markdown-malformed-rows');
    expect(err.message).toContain("'facture.pdf'");
    expect(err.message).toContain('Re-fix this file locally');
  });
});
