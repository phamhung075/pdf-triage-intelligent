import { describe, it, expect } from 'vitest';
import { auditMarkdownTables, countCells } from './markdown-tables.js';

describe('countCells', () => {
  it('ignores the leading and trailing pipes', () => {
    expect(countCells('| a | b | c |')).toBe(3);
    expect(countCells('| a |')).toBe(1);
  });
});

describe('auditMarkdownTables', () => {
  it('reports a clean table as having no ragged rows', () => {
    const md = [
      '| Date | Coût |',
      '| --- | --- |',
      '| 12/08 | 1,00 |',
      '| 13/08 | 2,00 |',
    ].join('\n');
    const r = auditMarkdownTables(md);
    expect(r.blocks).toBe(1);
    expect(r.dataRows).toBe(2);
    expect(r.raggedRows).toBe(0);
    expect(r.worstBlock).toBeNull();
  });

  it('catches the real Bouygues shape: 5-column header, 4-cell rows', () => {
    const md = [
      '| Date | Heure | Numéro appelé | Unité(s) décomptée(s) | Coût € TTC* |',
      '|:---|:---|:---|:---|:---|',
      '| 12/08 | 11:53:37 | 336528710 | 0,00 |',
      '| 12/08 | 11:54:33 | 336528710 | 0,00 |',
      '| 12/08 | 11:54:59 | 336528710 | 0,00 | 0,00 |',
    ].join('\n');
    const r = auditMarkdownTables(md);
    expect(r.dataRows).toBe(3);
    expect(r.raggedRows).toBe(2);
    expect(r.worstBlock?.headerCells).toBe(5);
    expect(r.worstBlock?.raggedRows).toBe(2);
  });

  it('treats two separate tables as separate blocks, not as one ragged table', () => {
    const md = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| X | Y | Z |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
    ].join('\n');
    const r = auditMarkdownTables(md);
    expect(r.blocks).toBe(2);
    expect(r.raggedRows).toBe(0); // differing column counts across blocks is legitimate
  });

  it('counts a block with no separator as headerless rather than ragged', () => {
    // A table continued across a chunk boundary: rows with no header above them.
    const md = ['| 12/08 | 11:53 | 0,00 |', '| 13/08 | 12:01 | 0,00 |'].join('\n');
    const r = auditMarkdownTables(md);
    expect(r.headerlessBlocks).toBe(1);
    expect(r.raggedRows).toBe(0);
    expect(r.dataRows).toBe(0);
  });

  it('returns an empty report for markdown with no tables at all', () => {
    const r = auditMarkdownTables('# Heading\n\nSome prose.\n');
    expect(r.blocks).toBe(0);
    expect(r.dataRows).toBe(0);
    expect(r.raggedRows).toBe(0);
  });

  it('handles empty and undefined input', () => {
    expect(auditMarkdownTables('').blocks).toBe(0);
    expect(auditMarkdownTables(undefined as any).blocks).toBe(0);
  });
});

import { measureContentRecall, FUSED_TEXT_AVG_WORD_LEN } from './markdown-tables.js';

describe('measureContentRecall', () => {
  // Distinct 6+ letter words with NO digits: the tokenizer's letter class stops at a digit, so
  // "word0".."word59" would all collapse to the single token "word".
  const many = (n: number, prefix: string) => {
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    return Array.from({ length: n }, (_, i) =>
      `${prefix}ontent${alpha[i % 26]}${alpha[Math.floor(i / 26) % 26]}${alpha[(i * 7) % 26]}`
    ).join(' ');
  };

  it('scores full recall when every content token survives', () => {
    const raw = many(60, 'se');
    const r = measureContentRecall(raw, `# Heading\n\n${raw}`);
    expect(r.measurable).toBe(true);
    expect(r.recall).toBe(1);
    expect(r.missingTokens).toBe(0);
  });

  it('detects dropped tokens', () => {
    const kept = many(50, 'se');
    // Under 15 chars each: long runs are treated as fusion artifacts and deliberately ignored.
    const dropped = 'consommateur resiliation penalite';
    const r = measureContentRecall(`${kept} ${dropped}`, kept);
    expect(r.measurable).toBe(true);
    expect(r.missingTokens).toBe(3);
    expect(r.recall).toBeLessThan(1);
  });

  it('refuses to measure heavily fused raw text, where de-fusing is the right behaviour', () => {
    // No spaces at all: raw tokens are unmatchable by construction, and the markdown is BETTER.
    const fused = 'Jemepermetsdevousadressermacandidaturepourunstageauseindevotreentrepriseaveclobjectif'.repeat(4);
    const r = measureContentRecall(fused, 'Je me permets de vous adresser ma candidature pour un stage.');
    expect(r.avgWordLength).toBeGreaterThan(FUSED_TEXT_AVG_WORD_LEN);
    expect(r.measurable).toBe(false);
  });

  it('refuses to measure a document with too few tokens to be meaningful', () => {
    const r = measureContentRecall('Attestation de domicile signee', 'Attestation');
    expect(r.measurable).toBe(false);
  });

  it('ignores markup added by the conversion', () => {
    const raw = many(60, 'se');
    const md = raw.split(' ').map(w => `| ${w} |`).join('\n');
    const r = measureContentRecall(raw, `| Header |\n| --- |\n${md}`);
    expect(r.recall).toBe(1); // pipes and dashes are not content tokens
  });

  it('handles empty input without throwing', () => {
    const r = measureContentRecall('', '');
    expect(r.measurable).toBe(false);
    expect(r.recall).toBe(1);
  });
});

describe('measureContentRecall — fusion detection beyond average token length', () => {
  it('skips a statement that is fused despite a modest average token length', () => {
    // The real RCHQ_101 shape: surviving spaces keep the mean at ~19, well under the 25 cutoff,
    // while half the tokens are glued-together runs.
    const raw = 'DateNaturedesoperationsValeurDebitCredit 99999LIEUXXXX 12RUEQUELQUEPART '
      + 'CHAMBRE1BATIMENTB MRNOMPRENOMX 0000000000 Agence: VILLERONDPO ELEVEDECOMPTECHEQUESR '
      + 'du06avril2010au06mai2010 RIB: 00000000000000000000000 IBAN: FR7600000000000000000000000';
    const r = measureContentRecall(raw, '## Relevé de compte\n\n17 avenue de Luminy');
    expect(r.avgWordLength).toBeLessThan(FUSED_TEXT_AVG_WORD_LEN); // the old guard would have missed it
    expect(r.measurable).toBe(false);
  });

  it('still measures a clean statement that merely contains long account numbers', () => {
    const a = 'abcdefghijklmnopqrstuvwxyz';
    // Alphabetic only: the tokenizer's letter class stops at a digit, so "libelleA0" would collapse.
    const words = Array.from({ length: 80 }, (_, i) => `libelle${a[i % 26]}${a[Math.floor(i / 26) % 26]}${a[(i * 5) % 26]}`).join(' ');
    const raw = `${words} 00000000000000000000000 FR7600000000000000000000000`;
    const r = measureContentRecall(raw, raw);
    expect(r.measurable).toBe(true);
    expect(r.recall).toBe(1);
  });
});

describe('measureContentRecall — fusion artifacts are not evidence of loss', () => {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  const distinct = (n: number) =>
    Array.from({ length: n }, (_, i) => `libelle${a[i % 26]}${a[Math.floor(i / 26) % 26]}${a[(i * 5) % 26]}`).join(' ');

  it('ignores a missing token that is a run-together word', () => {
    const kept = distinct(60);
    // The model split this into real words, so the glued form legitimately disappears.
    const raw = `${kept} evolutionsmensuellesdevotrecomptecheques`;
    const r = measureContentRecall(raw, kept);
    expect(r.missingTokens).toBe(0);
    expect(r.recall).toBe(1);
  });

  it('ignores a missing numeric run carrying several decimal commas', () => {
    const kept = distinct(60);
    const raw = `${kept} 00,71039,92139,211`;
    const r = measureContentRecall(raw, kept);
    expect(r.missingTokens).toBe(0);
  });

  it('still counts an ordinary word that vanished', () => {
    const kept = distinct(60);
    const raw = `${kept} consommateur resiliation penalite`;
    const r = measureContentRecall(raw, kept);
    expect(r.missingTokens).toBe(3);
  });

  it('flags fusion as suspected when the text has camel-case seams but is still measurable', () => {
    const kept = distinct(60);
    const r = measureContentRecall(`${kept} DateNature valeurDebit`, kept + ' DateNature valeurDebit');
    expect(r.measurable).toBe(true);
    expect(r.fusionSuspected).toBe(true);
  });

  it('does not suspect fusion in ordinary clean text', () => {
    const kept = distinct(60);
    const r = measureContentRecall(kept, kept);
    expect(r.fusionSuspected).toBe(false);
  });
});
