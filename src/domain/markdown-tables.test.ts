import { describe, it, expect } from 'vitest';
import { auditMarkdownTables, countCells, neutralizeChartLikeTables, normalizeMalformedPipeRows, mergeHeaderlessContinuationBlocks, reattachHeadingSplitTableRows, restoreMissingTableHeaderCells, CHART_TABLE_MAX_HEADER_CELLS } from './markdown-tables.js';

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

describe('neutralizeChartLikeTables', () => {
  it('leaves a real table untouched', () => {
    const md = [
      '| Date | Coût |',
      '| --- | --- |',
      '| 12/08 | 1,00 |',
    ].join('\n');
    const r = neutralizeChartLikeTables(md);
    expect(r.markdown).toBe(md);
    expect(r.neutralizedBlocks).toBe(0);
  });

  it('converts the doc-5009 shape — a huge axis header with empty data rows — into a verbatim blockquote', () => {
    // 20 "columns" of chart axis fragments; the single data row is all empty cells.
    const header = Array.from({ length: 20 }, (_, i) => i % 3 === 0 ? `Mar2${i}` : (i % 3 === 1 ? 'de' : 'à')).join(' | ');
    const emptyRow = Array.from({ length: 20 }, () => '').join(' | ');
    const md = [
      `## Evolution de votre consommation`,
      `| ${header} |`,
      `| ${Array.from({ length: 20 }, () => '---').join(' | ')} |`,
      `| ${emptyRow} |`,
    ].join('\n');

    const r = neutralizeChartLikeTables(md);
    expect(r.neutralizedBlocks).toBe(1);
    expect(r.neutralizedLines).toBe(3);
    // Every original line survives — prefixed, never dropped (zero content skipping).
    expect(r.markdown).toContain('Mar20');
    expect(r.markdown).toContain('> ⚠️ [Wide non-tabular region (20 columns)');
    // The blockquote lines are no longer audit-counted as a (healthy) table.
    expect(auditMarkdownTables(r.markdown).blocks).toBe(0);
  });

  it('keeps a block at or below the threshold as a real table', () => {
    const width = CHART_TABLE_MAX_HEADER_CELLS - 1;
    const header = Array.from({ length: width }, (_, i) => `col${i}`).join(' | ');
    const md = [
      `| ${header} |`,
      `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
      `| ${Array.from({ length: width }, (_, i) => `v${i}`).join(' | ')} |`,
    ].join('\n');
    const r = neutralizeChartLikeTables(md);
    expect(r.neutralizedBlocks).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('handles empty input', () => {
    const r = neutralizeChartLikeTables('');
    expect(r.neutralizedBlocks).toBe(0);
    expect(r.markdown).toBe('');
  });
});

describe('normalizeMalformedPipeRows', () => {
  it('restores the missing edge pipes on doc-5009-style rows and leaves well-formed rows alone', () => {
    const md = [
      '| Période | Prix | Montant | TVA |',
      '| --- | --- | --- | --- |',
      '| Base - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
      'Base - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0%',
      'Base - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0%',
    ].join('\n');
    const r = normalizeMalformedPipeRows(md);
    expect(r.fixedLines).toBe(2);
    expect(r.markdown).toContain('| Base - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0% |');
    expect(r.markdown).toContain('| Base - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0% |');
    // The repaired rows now belong to the table as far as the audit is concerned.
    expect(auditMarkdownTables(r.markdown).raggedRows).toBe(0);
  });

  it('never touches headings, blockquotes, lists or bold labels that merely contain pipes', () => {
    const md = [
      '## Base - du 01/02/26 | suite',
      '> **Relevé fin**: Conso kWh | Prix €HT/kWh | Montant €HT',
      '- alpha | beta',
      '**Montant €HT** | 21,49 | TVA',
    ].join('\n');
    const r = normalizeMalformedPipeRows(md);
    expect(r.fixedLines).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('returns the markdown unchanged when there is nothing to fix', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const r = normalizeMalformedPipeRows(md);
    expect(r.fixedLines).toBe(0);
    expect(r.markdown).toBe(md);
  });
});

describe('mergeHeaderlessContinuationBlocks', () => {
  it('re-joins headerless rows that directly follow a matching-width table across a blank line', () => {
    const md = [
      '| Date | Montant | Label |',
      '| --- | --- | --- |',
      '| 2024-05-01 | 100.00 | Salaire |',
      '',
      '| 2024-05-02 | 200.00 | Loyer |',
      '| 2024-05-03 | 300.00 | EDF |',
    ].join('\n');
    const r = mergeHeaderlessContinuationBlocks(md);
    expect(r.mergedBlocks).toBe(1);
    const audit = auditMarkdownTables(r.markdown);
    expect(audit.headerlessBlocks).toBe(0);
    expect(audit.blocks).toBe(1);
    expect(audit.dataRows).toBe(3);
  });

  it('does not merge when the widths differ (a genuinely different table)', () => {
    const md = [
      '| Date | Montant |',
      '| --- | --- |',
      '| 2024-05-01 | 100.00 |',
      '',
      '| 2024-05-02 | 200.00 | 300.00 | Autre table |',
    ].join('\n');
    const r = mergeHeaderlessContinuationBlocks(md);
    expect(r.mergedBlocks).toBe(0);
  });

  it('leaves markdown without orphan row blocks untouched', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const r = mergeHeaderlessContinuationBlocks(md);
    expect(r.mergedBlocks).toBe(0);
    expect(r.markdown).toBe(md);
  });
});

describe('reattachHeadingSplitTableRows', () => {
  // doc 5009's real shape: the Grille tarifaire table's continuation rows came back with their
  // descriptions promoted to headings and only the value cells left as a 3-cell row, with the EDF
  // footnote paragraph sitting between the table's first two rows and the escaped rows.
  function doc5009Shape(): string {
    return [
      '| Période | Prix €HT/mois | Montant €HT | TVA |',
      '| :--- | :---: | :---: | :---: |',
      '| **Base - 03kVA** du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
      '| **Base - 03kVA** du 01/08/25 au 31/01/26 | 8,51 | 51,48 | 20,0% |',
      '',
      '--- habituellement 2 fois par an, au 1er février et au 1er août. Vous pouvez retrouver la grille tarifaire en vigueur sur notre site : https://particulier.edf.fr/fr/accueil/electricite-gaz/tarif-bleu.html',
      'Nous vous rappelons que vous restez libre de changer de contrat à tout moment et sans frais.',
      '',
      'Document à conserver 5 ans',
      '',
      '## Base - 03kVA - du 01/02/26 au 16/05/26',
      '| 9,16 | 31,62 | 20,0% |',
      '',
      '## Base - 03kVA - du 17/05/26 au 15/06/26',
      '| 9,16 | 9,16 | 20,0% |',
      '',
      '## Déduction - Base - 03kVA - du 17/05/25 au 15/06/25',
      '| 8,60 | -8,60 | 5,5% |',
    ].join('\n');
  }

  it('re-folds heading-promoted rows back into their parent table across a footnote (doc-5009 shape)', () => {
    const r = reattachHeadingSplitTableRows(doc5009Shape());
    expect(r.reattachedRows).toBe(3);

    const audit = auditMarkdownTables(r.markdown);
    expect(audit.blocks).toBe(1); // the footnote no longer splits one table into blocks
    expect(audit.headerlessBlocks).toBe(0);
    expect(audit.raggedRows).toBe(0);
    expect(audit.dataRows).toBe(5);

    // The escaped rows are now full rows inside the table, description restored as first cell.
    expect(r.markdown).toContain('| Base - 03kVA - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0% |');
    expect(r.markdown).toContain('| Base - 03kVA - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0% |');
    expect(r.markdown).toContain('| Déduction - Base - 03kVA - du 17/05/25 au 15/06/25 | 8,60 | -8,60 | 5,5% |');
    // No heading promotion remains for those rows.
    expect(r.markdown).not.toContain('## Base - 03kVA - du 01/02/26');
    // The footnote stays in the document, AFTER the whole table (content is moved, never dropped).
    expect(r.markdown.indexOf('| Déduction - Base - 03kVA - du 17/05/25 au 15/06/25')).toBeLessThan(
      r.markdown.indexOf('--- habituellement 2 fois par an')
    );
    expect(r.markdown).toContain('Document à conserver 5 ans');
  });

  // doc 5009's Grille tarifaire on a run where the model ALSO dropped the leading "Période" header
  // cell: the header is "| Prix €HT/mois | Montant €HTTVA | TVA |" (3 cells) while every data row
  // carries its description cell (4 cells). The fold must match the DATA width, not the header —
  // a strict header match would silently skip the escape.
  function doc5009HeaderLostShape(): string {
    return [
      '| Prix €HT/mois | Montant €HTTVA | TVA |',
      '| :--- | :--- | :--- |',
      '| Abonnement<br>Base - 03kVA - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
      '| Base - 03kVA - du 01/08/25 au 31/01/26 | 8,51 | 51,48 | 20,0% |',
      '',
      '## Base - 03kVA - du 01/02/26 au 16/05/26',
      '| 9,16 | 31,62 | 20,0% |',
      '',
      '## Base - 03kVA - du 17/05/26 au 15/06/26',
      '| 9,16 | 9,16 | 20,0% |',
      '',
      '## Déduction - Base - 03kVA - du 17/05/25 au 15/06/25',
      '| 8,60 | -8,60 | 5,5% |',
    ].join('\n');
  }

  it('re-folds escaped rows even when the parent header lost its leading column (doc-5009 run variant)', () => {
    const r = reattachHeadingSplitTableRows(doc5009HeaderLostShape());
    expect(r.reattachedRows).toBe(3);

    const audit = auditMarkdownTables(r.markdown);
    expect(audit.blocks).toBe(1);
    expect(audit.headerlessBlocks).toBe(0);
    expect(audit.dataRows).toBe(5);

    // The escaped rows are back inside the table, description restored as first cell.
    expect(r.markdown).toContain('| Base - 03kVA - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0% |');
    expect(r.markdown).toContain('| Déduction - Base - 03kVA - du 17/05/25 au 15/06/25 | 8,60 | -8,60 | 5,5% |');
    expect(r.markdown).not.toContain('## Base - 03kVA - du 01/02/26');
    // Content that was never part of an escape is untouched (first two rows keep their spacing).
    expect(r.markdown).toContain('| Abonnement<br>Base - 03kVA - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |');
  });

  it('leaves a heading that introduces its own small textual table alone', () => {
    const md = [
      '| Date | Montant | Label |',
      '| --- | --- | --- |',
      '| 2024-05-01 | 100.00 | Salaire |',
      '',
      '## Récapitulatif',
      '| Total | 1 234,56 € |', // width matches the 3-col table above, but cells are NOT all values
    ].join('\n');
    const r = reattachHeadingSplitTableRows(md);
    expect(r.reattachedRows).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('leaves a heading followed by several rows alone (a real section + table)', () => {
    const md = [
      '| Date | Montant |',
      '| --- | --- |',
      '| 2024-05-01 | 100.00 |',
      '',
      '## Paiements suivants',
      '| 2024-05-02 | 200.00 |',
      '| 2024-05-03 | 300.00 |',
    ].join('\n');
    const r = reattachHeadingSplitTableRows(md);
    expect(r.reattachedRows).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('leaves a lone numeric row with no matching-width table above untouched', () => {
    const md = [
      '## Récapitulatif',
      '| 9,16 | 31,62 | 20,0% |',
    ].join('\n');
    const r = reattachHeadingSplitTableRows(md);
    expect(r.reattachedRows).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('does not reach across a far-away matching table to steal an unrelated row', () => {
    const gap = Array.from({ length: 15 }, (_, i) => `Paragraphe intermediaire numero ${i}.`).join('\n');
    const md = [
      '| A | B | C | D |',
      '| --- | --- | --- | --- |',
      '| 1 | 2 | 3 | 4 |',
      '',
      gap,
      '',
      '## Base - 03kVA - du 01/02/26 au 16/05/26',
      '| 9,16 | 31,62 | 20,0% |',
    ].join('\n');
    const r = reattachHeadingSplitTableRows(md);
    expect(r.reattachedRows).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('handles empty and clean input as a no-op', () => {
    expect(reattachHeadingSplitTableRows('').reattachedRows).toBe(0);
    const clean = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const r = reattachHeadingSplitTableRows(clean);
    expect(r.reattachedRows).toBe(0);
    expect(r.markdown).toBe(clean);
  });
});

describe('restoreMissingTableHeaderCells', () => {
  // doc 5009's Grille tarifaire on a run where the model dropped the leading header cell: the
  // header claims only the numeric columns ("| Prix €HT/mois | Montant €HTTVA | TVA |") while every
  // data row still carries its description cell. No heading escaped here, so only this pass can
  // restore the width.
  function shortHeaderShape(): string {
    return [
      '| Prix €HT/mois | Montant €HTTVA | TVA |',
      '| :--- | :--- | :--- |',
      '| Abonnement<br>Base - 03kVA - du 17/05/25 au 31/07/25 | 8,60 | 21,49 | 5,5% |',
      '| Base - 03kVA - du 01/08/25 au 31/01/26 | 8,51 | 51,48 | 20,0% |',
      '| Base - 03kVA - du 01/02/26 au 16/05/26 | 9,16 | 31,62 | 20,0% |',
      '| Base - 03kVA - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0% |',
      '| Déduction - Base - 03kVA - du 17/05/25 au 15/06/25 | 8,60 | -8,60 | 5,5% |',
    ].join('\n');
  }

  it('gives a header that is one cell short of every row its missing leading cell back (doc-5009 shape)', () => {
    const r = restoreMissingTableHeaderCells(shortHeaderShape());
    expect(r.restoredHeaders).toBe(1);

    const audit = auditMarkdownTables(r.markdown);
    expect(audit.blocks).toBe(1);
    expect(audit.headerlessBlocks).toBe(0);
    expect(audit.raggedRows).toBe(0);
    expect(audit.dataRows).toBe(5);

    expect(r.markdown).toContain('|  | Prix €HT/mois | Montant €HTTVA | TVA |');
    // Separator is padded in step with the header so the block stays one aligned table.
    expect(r.markdown).toContain('|  | :--- | :--- | :--- |');
    // Data rows are untouched — only the header/separator width changes.
    expect(r.markdown).toContain('| Base - 03kVA - du 17/05/26 au 15/06/26 | 9,16 | 9,16 | 20,0% |');
  });

  it('leaves healthy tables whose rows match their header alone', () => {
    const md = [
      '| Période | Prix €HT/mois | Montant €HT | TVA |',
      '| :--- | :--- | :--- | :--- |',
      '| Base - 03kVA | 8,60 | 21,49 | 5,5% |',
      '| Base - 03kVA | 8,51 | 51,48 | 20,0% |',
    ].join('\n');
    const r = restoreMissingTableHeaderCells(md);
    expect(r.restoredHeaders).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('leaves a block whose rows are ragged in a different way alone', () => {
    // One row is one cell short of the header, not one cell wider — a shifted-value shape the
    // model must fix, not a missing header label.
    const md = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
      '| 4 | 5 |',
    ].join('\n');
    const r = restoreMissingTableHeaderCells(md);
    expect(r.restoredHeaders).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('leaves a block whose first cells are values alone (extra width is trailing, not a lost label column)', () => {
    // Rows one cell wider than the header, but the extra width is a trailing value: the missing
    // cell's position is undecidable, so nothing is padded.
    const md = [
      '| Libellé | Montant |',
      '| --- | --- |',
      '| Salaire | 1 200,00 | 5,5% |',
      '| Prime | 300,00 | 5,5% |',
    ].join('\n');
    const r = restoreMissingTableHeaderCells(md);
    expect(r.restoredHeaders).toBe(0);
    expect(r.markdown).toBe(md);
  });

  it('handles empty and headerless input as a no-op', () => {
    expect(restoreMissingTableHeaderCells('').restoredHeaders).toBe(0);
    const headerless = '| 1 | 2 |\n| 3 | 4 |'; // no separator -> no header to compare
    const r = restoreMissingTableHeaderCells(headerless);
    expect(r.restoredHeaders).toBe(0);
    expect(r.markdown).toBe(headerless);
  });
});
