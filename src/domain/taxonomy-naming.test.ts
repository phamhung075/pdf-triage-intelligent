import { describe, it, expect } from 'vitest';
import { isGenericFilename, generateIntelligentFilename, computeCanonicalPath } from './taxonomy.js';

describe('Intelligent Filename Generator', () => {
  it('identifies generic, ambiguous, or unhelpful filenames', () => {
    expect(isGenericFilename('QPtmp001.PDF')).toBe(true);
    expect(isGenericFilename('invoice (8).pdf')).toBe(true);
    expect(isGenericFilename('20211130_blocked1.pdf')).toBe(true);
    expect(isGenericFilename('98765432109876543210987-recap.pdf')).toBe(true);
    expect(isGenericFilename('b3ecb7ae978c68b1672285ff42609db1_document.pdf')).toBe(true);
    expect(isGenericFilename('fileopen (1).pdf')).toBe(true);
    expect(isGenericFilename('scan_001.pdf')).toBe(true);
    expect(isGenericFilename('2022.pdf')).toBe(true);
    expect(isGenericFilename('url.pdf')).toBe(true);

    // Meaningful names should NOT be marked generic
    expect(isGenericFilename('Facture_SFR_Mai_2024.pdf')).toBe(false);
    expect(isGenericFilename('Attestation_Navigo_2025.pdf')).toBe(false);
  });

  it('generates clean, structured intelligent filenames for generic files', () => {
    const fn1 = generateIntelligentFilename(
      'QPtmp001.PDF',
      'Bulletin de Salaire - Juillet 2023',
      'bulletin_salaire',
      'globex',
      '2023-07-31'
    );
    expect(fn1).toBe('2023-07-31_Globex_Bulletin_De_Salaire_Juillet.pdf');

    const fn2 = generateIntelligentFilename(
      'invoice (8).pdf',
      'Facture Matériel Informatique',
      'invoices',
      'amazon',
      '2023-11-15'
    );
    expect(fn2).toBe('2023-11-15_Amazon_Facture_Materiel_Informatique.pdf');

    const fn3 = generateIntelligentFilename(
      '13320220423-recap.pdf',
      'Attestation Dépôt Permis de Conduire',
      'identity',
      'ants',
      '2022-04-23'
    );
    expect(fn3).toBe('2022-04-23_Ants_Attestation_Depot_Permis_De_Conduire.pdf');
  });

  it('preserves clean, meaningful filenames', () => {
    const fn = generateIntelligentFilename(
      'Facture_SFR_Mai_2024.pdf',
      'Facture SFR Mai 2024',
      'invoices',
      'sfr',
      '2024-05-12'
    );
    expect(fn).toBe('Facture_SFR_Mai_2024.pdf');
  });

  it('updates computeCanonicalPath with the intelligent filename', () => {
    const canonical = computeCanonicalPath(
      'C:/tmp/QPtmp001.PDF',
      'bulletin_salaire',
      'C:/archive',
      'globex',
      '2023-07-31',
      'Bulletin de Salaire - Juillet 2023'
    );
    expect(canonical.replace(/\\/g, '/')).toBe('C:/archive/bulletin_salaire/globex/2023/2023-07-31_Globex_Bulletin_De_Salaire_Juillet.pdf');
  });
});
