import { describe, it, expect } from 'vitest';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify, preprocessRawText, normalizeSlug, reconcileDocumentDate } from './classification.js';
import { EntityDictionary } from './document.schema.js';

describe('normalizeSlug', () => {
  it('strips accents instead of replacing them with underscores — regression guard for the "propri_taire" bug (accented "propriétaire" mid-word breakage)', () => {
    expect(normalizeSlug('Propriétaire')).toBe('proprietaire');
  });

  it('still collapses genuinely non-alphanumeric separators (spaces, punctuation) into underscores', () => {
    expect(normalizeSlug('Crédit Mutuel / Marseille')).toBe('credit_mutuel_marseille');
  });
});

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['dupond', 'martin', 'lefebvre', 'bernard'];

function dictionaryWith(overrides: Partial<EntityDictionary>): EntityDictionary {
  return { ...EMPTY_DICTIONARY, ...overrides };
}

describe('cleanAndParseJSON', () => {
  it('strips ```json fences and trailing commas', () => {
    const raw = '```json\n{"titre": "Test", "categorie": "invoices",}\n```';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', categorie: 'invoices' });
  });

  it('throws when the response has no JSON object at all', () => {
    expect(() => cleanAndParseJSON('I cannot help with that request.')).toThrow(
      'No JSON object found in AI response'
    );
  });

  it('repairs a truncated response (unterminated string, missing closing brace)', () => {
    const raw = '{"titre": "Test Doc", "markdown_content": "some unterminated text';
    expect(cleanAndParseJSON(raw)).toEqual({
      titre: 'Test Doc',
      markdown_content: 'some unterminated text',
    });
  });

  it('repairs truncation inside a nested array', () => {
    const raw = '{"titre": "Test", "tags": ["a", "b"';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', tags: ['a', 'b'] });
  });

  it('ignores text before the first { and after the last }', () => {
    const raw = 'Here is the JSON: {"titre": "Test"} — hope that helps!';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test' });
  });
});

describe('preprocessRawText', () => {
  it('de-concatenates fused OCR text with camelCase, number boundaries, and currency symbols', () => {
    const raw = 'Invoice Customersname:PHAMD Totalpayable€12.98 Invoicedate/ Deliverydate02.05.2024 Order#406-5109483';
    const processed = preprocessRawText(raw);
    expect(processed).toContain('Invoice Customers name: PHAMD');
    expect(processed).toContain('Total payable € 12.98');
    expect(processed).toContain('Invoice date/ Delivery date 02.05.2024');
    expect(processed).toContain('Order # 406-5109483');
  });
});

describe('matchEntityDictionary', () => {
  it('matches an entity by its exact name, case-insensitively', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: ['ca'] }] });
    const result = matchEntityDictionary('extrait de compte crédit agricole paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'bank', subcategorie: 'credit_agricole' });
  });

  it('matches an entity by alias', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'maif', name: 'MAIF', aliases: ['mutuelle assurance instituteurs'] }] });
    const result = matchEntityDictionary('contrat mutuelle assurance instituteurs 2024', ['insurance'], dict);
    expect(result).toEqual({ categorie: 'insurance', subcategorie: 'maif' });
  });

  it('matches accented entity names against accented text (Unicode word boundary)', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'societe_generale', name: 'Société Générale', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte société générale paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'bank', subcategorie: 'societe_generale' });
  });

  it('does NOT match an accented entity name against unaccented search text — this is why every accented entity in entity_dictionary.json must also ship an unaccented alias', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte credit agricole paris', ['banks'], dict);
    expect(result).toBeNull();
  });

  it('does not match a name as a substring of a longer word (word-boundary correctness)', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }] });
    // "taxaphone" contains "axa" as a substring but is not a match
    const result = matchEntityDictionary('société taxaphone service client', ['insurance'], dict);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(matchEntityDictionary('nothing recognizable here', ['banks'], dict)).toBeNull();
  });
});

describe('buildEntityHintLine', () => {
  it('formats matching entities as "slug (Name), slug (Name)."', () => {
    const dict = dictionaryWith({
      banks: [
        { slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] },
        { slug: 'fortuneo', name: 'Fortuneo', aliases: [] },
      ],
    });
    expect(buildEntityHintLine('bank', dict)).toBe(
      ' Known real-world entities: credit_agricole (Crédit Agricole), fortuneo (Fortuneo).'
    );
  });

  it('returns an empty string when no domain maps to the category', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(buildEntityHintLine('totally_made_up_category_xyz', dict)).toBe('');
  });
});

describe('isGroundedSubcategorySlug', () => {
  it('rejects a slug shorter than 3 characters', () => {
    expect(isGroundedSubcategorySlug('ab', 'ab ab ab', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a generic/structural word even if it appears in the text', () => {
    expect(isGroundedSubcategorySlug('page', 'page 1 of page 2', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug built from a personal/household name token', () => {
    expect(isGroundedSubcategorySlug('jean_dupond', 'jean dupond jean dupond', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug with zero occurrences in the document text', () => {
    expect(isGroundedSubcategorySlug('veolia', 'nothing here', 'random.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a filename-echoed slug that appears only once in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia mentioned once', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(false);
  });

  it('accepts a filename-echoed slug that appears at least twice in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });

  it('accepts a non-filename-echoed slug that appears once in the text', () => {
    expect(
      isGroundedSubcategorySlug('france_travail', 'Contact France Travail for details', 'doc123.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });
});

describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const dict = dictionaryWith({ gov: [{ slug: 'employeur_x', name: 'Pacifique 4', aliases: ['employeur_x'] }] });
    const result = ruleBasedClassify(
      'Bulletin de salaire EmployeurX Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf',
      dict,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('employeur_x');
    expect(result.title).toBe('bulletin mars');
    expect(result.date).toBe('2023-03-01');
  });

  it('classifies a passport under identity/passeport', () => {
    const result = ruleBasedClassify('Republique Francaise Passeport N 12AB34567', 'doc.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('identity');
    expect(result.subcategorie).toBe('passeport');
  });

  it('classifies titre-An-Ngo.pdf and titre-Dung-Ngo.pdf under identity/titre_sejour', () => {
    const res1 = ruleBasedClassify('Carte de sejour residence permit', 'titre-An-Ngo.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res1.categorie).toBe('identity');
    expect(res1.subcategorie).toBe('titre_sejour');

    const res2 = ruleBasedClassify('Residence permit France', 'titre-Dung-Ngo.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res2.categorie).toBe('identity');
    expect(res2.subcategorie).toBe('titre_sejour');
  });

  it('classifies a plain tax notice under administrative/impot', () => {
    const result = ruleBasedClassify(
      "Direction Generale des Finances Publiques DGFIP Avis d'impot sur le revenu 2023",
      'impot2023.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('impot');
  });

  it('does NOT misfile a bank statement as impot just because a transaction row mentions impots (Golden Rule #6 guard)', () => {
    const result = ruleBasedClassify(
      'RELEVE DE COMPTE Credit Mutuel Marseille PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
      'releve.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('bank');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('classifies a vendor invoice via the hardcoded regex branch, with compact YYYYMMDD date', () => {
    const result = ruleBasedClassify('Facture SFR n 123456 Total TTC 45.99 EUR 20240512', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
    expect(result.invoice_type).toBe('SUPPLIER');
    expect(result.date).toBe('2024-05-12');
  });

  it('classifies a client sales invoice under factures_clients and detects PAID / UNPAID status', () => {
    const resClientPaid = ruleBasedClassify(
      'Facture client N 2026-001 Destinataire Acme Corp Acme Corp Montant 1500 EUR PAYÉ PAR VIREMENT',
      'facture_client_acme.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(resClientPaid.categorie).toBe('factures_clients');
    expect(resClientPaid.subcategorie).toBe('acme');
    expect(resClientPaid.invoice_type).toBe('CLIENT');
    expect(resClientPaid.payment_status).toBe('PAID');

    const resClientUnpaid = ruleBasedClassify(
      'Facture de vente N 2026-002 Client Beta Solde à régler avant le 15/09/2026 EN ATTENTE',
      'facture_client_beta.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(resClientUnpaid.categorie).toBe('factures_clients');
    expect(resClientUnpaid.invoice_type).toBe('CLIENT');
    expect(resClientUnpaid.payment_status).toBe('UNPAID');
  });

  it('classifies a vendor invoice via the entity-dictionary fallback when no hardcoded regex matches', () => {
    const dict = dictionaryWith({ energy: [{ slug: 'ekwateur', name: 'Ekwateur', aliases: [] }] });
    const result = ruleBasedClassify('Facture Ekwateur Total TTC 45 EUR', 'facture2.pdf', dict, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('ekwateur');
  });

  it('leaves subcategorie as "general" when no signal matches and the filename word is not grounded in the text', () => {
    const result = ruleBasedClassify(
      'Hello world this is a test document with nothing recognizable.',
      'randomfile.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('general');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to today's date — don't assert the exact day
  });

  it('dynamically accepts a new subcategory slug from the filename when it is genuinely grounded in the text', () => {
    const result = ruleBasedClassify(
      'Contrat Veolia Eau - consommation trimestrielle, montant total 32.10 EUR. Merci de votre confiance, Veolia.',
      'veolia_invoice.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('veolia');
  });

  it('correctly classifies savings summaries (SYN_EPARGNE, SYN_EP_CREDIT) as credit_mutuel', () => {
    const res = ruleBasedClassify('SYNTHESE EPARGNE CRÉDIT MUTUEL COMPTE N 300040047000000560905', 'SYN_EPARGNE_300040047000000560905_20190401.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('credit_mutuel');
  });

  it('correctly classifies check statements (RCHQ) and account statements (RCE)', () => {
    const resChq = ruleBasedClassify('RELEVE DE CHEQUES COMPTE 000000000000000000000', 'RCHQ_101_000000000000000000000_20100607_2350.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resChq.subcategorie).toBe('credit_mutuel');

    const resRce = ruleBasedClassify('RELEVE DE COMPTE EUROCOMPTE CREDIT MUTUEL', 'RCE_00050974642_20201205.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resRce.subcategorie).toBe('credit_mutuel');
  });

  it('correctly classifies academic transcripts (relevés de notes)', () => {
    const res = ruleBasedClassify('Relevé de notes semestriels et trimestriels Université L1 Informatique', 'relevés de notes semestriels ou trimestriels.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res.categorie).toBe('education');
    expect(res.subcategorie).toBe('releve_notes');
  });

  it('correctly classifies récépissés and identity papers', () => {
    const resRec = ruleBasedClassify('Récépissé de demande de titre de séjour Préfecture', 'Recipisse20240424.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resRec.categorie).toBe('identity');
    expect(resRec.subcategorie).toBe('recipisse_sejour');

    const resIdentite = ruleBasedClassify('Carte d\'identité nationale République Française', 'piece_identiteB20200313.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resIdentite.categorie).toBe('identity');
    expect(resIdentite.subcategorie).toBe('carte_identite');
  });

  it('correctly classifies Kbis and Work Stoppages (Arrêt de travail)', () => {
    const resKbis = ruleBasedClassify('Extrait Kbis Greffe du Tribunal de Commerce', 'Kbis_Laviedessouvenirs20190414_13001827.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resKbis.categorie).toBe('administrative');
    expect(resKbis.subcategorie).toBe('kbis');

    const resArret = ruleBasedClassify('Avis d\'arrêt de travail Sécurité Sociale AMELI', 'Arrêt de travail.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resArret.categorie).toBe('health');
    expect(resArret.subcategorie).toBe('arret_travail');
  });

  it('correctly classifies theft claims (déclaration de vol)', () => {
    const resVol = ruleBasedClassify('Procès verbal de dépôt de plainte pour déclaration de vol', 'declaration-de-vol.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resVol.categorie).toBe('insurance');
    expect(resVol.subcategorie).toBe('declaration_vol');
  });

  it('correctly classifies English documents (Bank Statements, Payslips, Invoices, Contracts, Identity, Transcripts)', () => {
    const resBank = ruleBasedClassify('Checking Account Statement Opening Balance $5,000.00 Closing Balance $4,200.00', 'bank_statement_2026.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resBank.categorie).toBe('bank');
    expect(resBank.subcategorie).toBe('releve_bancaire');

    const resPayslip = ruleBasedClassify('Employee Pay Stub Gross Pay $3,500 Net Pay $2,800 Employer ACME Corp', 'payslip_august.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resPayslip.categorie).toBe('bulletin_salaire');

    const resContract = ruleBasedClassify('Employment Agreement Terms and Conditions Non-Disclosure Agreement', 'employment_contract.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resContract.categorie).toBe('contracts');

    const resTranscript = ruleBasedClassify('Official Academic Transcript Grade Report Bachelor of Science Degree', 'transcript.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(resTranscript.categorie).toBe('education');
    expect(resTranscript.subcategorie).toBe('releve_notes');
  });
});

describe('reconcileDocumentDate', () => {
  const NOW = new Date('2026-08-12T00:00:00');

  it('corrects a future DD/MM/YYYY date to the titre year when it is an OCR two-digit-year misread (the doc #2472 bug)', () => {
    const result = reconcileDocumentDate('30/11/2026', 'Bulletin de salaire - Novembre 2025', NOW);
    expect(result.corrected).toBe(true);
    expect(result.date).toBe('2025-11-30');
    expect(result.reason).toMatch(/later than today/);
  });

  it('leaves a past date untouched, even if the titre mentions a different year', () => {
    const result = reconcileDocumentDate('2026-06-30', 'Bulletin de salaire - Juin 2026', NOW);
    expect(result.corrected).toBe(false);
    expect(result.date).toBe('2026-06-30');
  });

  it('leaves a future date untouched when the titre has no extractable year', () => {
    const result = reconcileDocumentDate('30/11/2026', 'Bulletin de salaire', NOW);
    expect(result.corrected).toBe(false);
    expect(result.date).toBe('30/11/2026');
  });

  it('leaves a future date untouched when the titre year would still be in the future', () => {
    const result = reconcileDocumentDate('30/11/2099', 'Facture 2098', NOW);
    expect(result.corrected).toBe(false);
    expect(result.date).toBe('30/11/2099');
  });

  it('leaves an unparseable date string untouched', () => {
    const result = reconcileDocumentDate('N/A', 'Bulletin de salaire - Novembre 2025', NOW);
    expect(result.corrected).toBe(false);
    expect(result.date).toBe('N/A');
  });
});
