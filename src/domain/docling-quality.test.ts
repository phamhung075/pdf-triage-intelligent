import { describe, it, expect } from 'vitest';
import {
  assessDoclingMarkdown,
  projectDoclingMarkdownToText,
} from './docling-quality.js';

describe('projectDoclingMarkdownToText', () => {
  it('strips structure but keeps document content', () => {
    const md = [
      '# Relevé de compte',
      '',
      '## Opérations',
      '',
      '| Date | Débit | Crédit |',
      '| --- | --- | --- |',
      '| 03/10/2023 | -2,00 EUR | |',
      '',
      'Montant total : **1 546,02 EUR**',
      '',
      '> Référence à rappeler',
      '',
      '<!-- image -->',
    ].join('\n');

    const text = projectDoclingMarkdownToText(md);
    expect(text).toContain('Relevé de compte');
    expect(text).toContain('Date Débit Crédit');
    expect(text).toContain('03/10/2023');
    expect(text).toContain('1 546,02 EUR');
    expect(text).toContain('Référence à rappeler');
    // Heading markers, emphasis and the image placeholder are gone.
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
    expect(text).not.toContain('<!-- image -->');
    expect(text).not.toContain('|');
  });
});

describe('assessDoclingMarkdown', () => {
  it('accepts a clean structured bank-statement markdown', () => {
    const report = assessDoclingMarkdown(
      [
        '# Relevé de compte Crédit Mutuel',
        '',
        '| Date | Opération | Débit |',
        '| --- | --- | --- |',
        '| 03/10/2023 | PRLV SEPA PAYPAL | -2,00 EUR |',
        '| 28/09/2023 | VIR DE MME DUPONT | +1 000,00 EUR |',
      ].join('\n')
    );
    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.metrics.textChars).toBeGreaterThan(10);
    expect(report.metrics.proseScore).toBeGreaterThan(1.0);
  });

  it('rejects a whole-page-picture output (only an image placeholder)', () => {
    const report = assessDoclingMarkdown('<!-- image -->');
    expect(report.pass).toBe(false);
    expect(report.failures.some(f => f.id === 'docling-no-text')).toBe(true);
    expect(report.metrics.imagePlaceholders).toBe(1);
  });

  it('rejects short/empty markdown (the photo-derived PDF failure class)', () => {
    expect(assessDoclingMarkdown('').pass).toBe(false);
    expect(assessDoclingMarkdown('<!-- image -->\n\n<!-- image -->').pass).toBe(false);
  });

  it('rejects garbage text-layer decodes that are not prose (Hangul mojibake class)', () => {
    // Doc 3/4 of the spike: a text layer decoded to CJK syllables is non-empty, non-corrupted at
    // the mid-word-capitalization detector, and only a structural check (nearly all 1-2 char
    // tokens) rejects it.
    const garbage = '쀆쀇 쀃쀃 쀆쀇쀆쀆 쀃쀃쀃쀃\n'.repeat(30) + '쀄쀄쀅쀅 쀄쀄쀄쀄쀄\n'.repeat(30);
    const report = assessDoclingMarkdown(garbage);
    expect(report.pass).toBe(false);
    expect(report.failures.some(f => f.id === 'docling-text-mojibake')).toBe(true);
  });

  it('rejects majority-ragged tables', () => {
    const md = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
      '| 4 | 5 |',
      '| 6 | 7 |',
      '| 8 | 9 |',
      '| 10 | 11 |',
      '| 12 | 13 |',
    ].join('\n');
    const report = assessDoclingMarkdown(md);
    expect(report.pass).toBe(false);
    expect(report.failures.some(f => f.id === 'docling-ragged-table')).toBe(true);
  });

  it('rejects content loss when a raw-text reference is provided', () => {
    // Enough DISTINCT content tokens (>= 40 per measureContentRecall's measurability floor) so the
    // recall comparison is meaningful, with many real words the markdown below omits.
    const words = [
      'relevé', 'mentionne', 'virement', 'Madame', 'Dupont', 'Marie', 'prélèvement', 'bénéfice',
      'société', 'SFR', 'Fixe', 'ADSL', 'assurance', 'mutuelle', 'complémentaire', 'échéance',
      'mensuelle', 'prélevé', 'compte', 'bancaire', 'domiciliation', 'titulaire', 'adresse',
      'facturation', 'abonnement', 'téléphonique', 'consommation', 'data', 'itinérance', 'facture',
      'montant', 'total', 'taxes', 'incluses', 'paiement', 'automatique', 'mandat', 'signature',
      'électronique', 'référence', 'opération', 'débit', 'crédit', 'solde', 'précédent', 'nouveau',
      'détail', 'ligne', 'opérations', 'relevés', 'déclarations', 'fiscales', 'année', 'précédente',
      'allocation', 'chômage', 'indemnisation', 'période', 'versement', 'caisse', 'retraite',
    ];
    const raw = words.join(' ') + '.';
    // Markdown that only keeps a small fraction of the source tokens.
    const md = '| Date | Montant |\n| --- | --- |\n| 03/10/2023 | -2,00 EUR |\n';
    const report = assessDoclingMarkdown(md, raw);
    expect(report.pass).toBe(false);
    expect(report.failures.some(f => f.id === 'docling-content-loss')).toBe(true);
  });

  it('passes a content-complete markdown against the same raw text', () => {
    const sentences = 'Le relevé mentionne un virement de la part de Madame Dupont Marie ' +
      'et un prélèvement au bénéfice de la société SFR Fixe ADSL.';
    const report = assessDoclingMarkdown(`# Relevé\n\n${sentences}`, sentences);
    expect(report.pass).toBe(true);
  });
});
