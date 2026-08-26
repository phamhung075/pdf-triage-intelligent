import { describe, it, expect } from 'vitest';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify, preprocessRawText, normalizeSlug, reconcileDocumentDate } from './classification.js';
import { EntityDictionary } from './document.schema.js';
import { PromptPersonalizationSchema } from './prompt-personalization.js';

describe('normalizeSlug', () => {
  it('strips accents instead of replacing them with underscores — regression guard for the "propri_taire" bug (accented "propriétaire" mid-word breakage)', () => {
    expect(normalizeSlug('Propriétaire')).toBe('proprietaire');
  });

  it('still collapses genuinely non-alphanumeric separators (spaces, punctuation) into underscores', () => {
    expect(normalizeSlug('Crédit Mutuel / Springfield')).toBe('credit_mutuel_springfield');
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
    const raw = 'Invoice Customersname:DUPONDJ Totalpayable€12.98 Invoicedate/ Deliverydate02.05.2024 Order#406-5109483';
    const processed = preprocessRawText(raw);
    expect(processed).toContain('Invoice Customers name: DUPONDJ');
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

describe('preprocessRawText false splits', () => {
  it('leaves ordinary words that merely end in a field keyword intact', () => {
    // This text is what Step A extracts the issuer from and Step D writes titre/summary from, so
    // a false split corrupts a value that is then fed back to Step D as "GROUND TRUTH".
    expect(preprocessRawText('private corporate surname username rate item code'))
      .toBe('private corporate surname username rate item code');
    expect(preprocessRawText('the candidate will consolidate and validate the mandate'))
      .toBe('the candidate will consolidate and validate the mandate');
  });

  it('still splits the genuine OCR fusions it exists for', () => {
    expect(preprocessRawText('Customersname')).toBe('Customers name');
    expect(preprocessRawText('Invoicedate')).toBe('Invoice date');
  });
});

describe('ruleBasedClassify — branch-shadowing regressions', () => {
  // Each case below was a live misclassification found by audit and reproduced before the fix.
  const c = (text: string, filename: string) => {
    const r = ruleBasedClassify(text, filename, EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    return `${r.categorie}/${r.subcategorie}`;
  };

  it('keeps a bank statement as bank when a fines row appears inside it (Golden Rule #6)', () => {
    // The fines branch used to be the only one ahead of the bank guard, so a single ANTAI debit
    // row in a relevé pulled the whole statement into administrative/amende.
    expect(c('RELEVE DE COMPTE CREDIT MUTUEL solde crediteur\n12/03 PRLV ANTAI amende -45,00', 'releve.pdf'))
      .toBe('bank/credit_mutuel');
  });

  it('still classifies a genuine fine when the document is not a statement', () => {
    expect(c('Avis de contravention ANTAI amende forfaitaire 45 euros', 'avis.pdf'))
      .toBe('administrative/amende');
  });

  it('does not read "CNIL" boilerplate as an identity document', () => {
    // 'cni' sat unanchored in the identity alternation, and the CNIL mention is boilerplate on
    // virtually every French official letter — identity runs ahead of health/housing/invoices.
    expect(c('Conformement a la loi informatique et libertes, la CNIL peut etre saisie. Facture n 123 Total TTC 45', 'lettre.pdf'))
      .toBe('invoices/facture');
  });

  it('does not read a Visa card payment as a residence permit', () => {
    expect(c('Paiement par carte visa le 12/03 Facture n 998 Total TTC 22,50', 'recu.pdf'))
      .toBe('invoices/facture');
  });

  it('still classifies a real long-stay visa as identity', () => {
    expect(c('Visa de long sejour titre de sejour prefecture', 'visa.pdf')).toBe('identity/titre_sejour');
  });

  it('does not turn "Business Center" in an address into a transport pass', () => {
    // /bus|navigo/ parses as (bus)|(navigo) — the leading boundary guarded only 'bus'.
    expect(c('Justificatif de domicile Business Center 12 rue des Lilas quittance', 'dom.pdf'))
      .toBe('housing/justificatif_domicile');
  });

  it('still classifies an actual transport document', () => {
    expect(c('Abonnement Navigo annuel ile-de-france', 'navigo.pdf')).toBe('administrative/navigo');
  });

  it('does not file a CDI as an internship because it mentions a past stage', () => {
    expect(c('Contrat de travail CDI. Le salarie a effectue un stage en 2019.', 'contrat.pdf'))
      .toBe('contracts/cdi_cdd');
  });

  it('still classifies a real internship attestation', () => {
    expect(c('Attestation de stage effectue du 01/01 au 30/06', 'stage.pdf'))
      .toBe('education/attestation_stage');
  });

  it('does not mint administrative/dossier_administratif from the word "dossier" in a letter', () => {
    expect(c('Madame, Monsieur, votre dossier a bien ete recu. Cordialement.', 'courrier.pdf'))
      .toBe('correspondence/general');
  });

  it('does not mint an invoices/free subcategory from the English word "free"', () => {
    // This one was grounded, so it was genuinely auto-created into the private taxonomy.
    expect(c('Invoice 42 Free delivery included Total due 99.00 USD', 'inv.pdf'))
      .toBe('invoices/facture');
  });

  it('still recognises the Free telecom operator', () => {
    expect(c('Facture Free Mobile forfait Total TTC 19,99', 'facture.pdf')).toBe('invoices/free');
  });
});

describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const dict = dictionaryWith({ gov: [{ slug: 'acme_corp', name: 'Acme Corp', aliases: ['acmecorp'] }] });
    const result = ruleBasedClassify(
      'Bulletin de salaire AcmeCorp Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf',
      dict,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('acme_corp');
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
      'RELEVE DE COMPTE Credit Mutuel Springfield PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
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

  it('classifies a savings summary naming its bank as bank/<bank_slug> off the generic French phrasing alone', () => {
    const res = ruleBasedClassify('SYNTHESE EPARGNE CRÉDIT MUTUEL COMPTE N 00000000000000000000', 'savings_summary_20190401.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('credit_mutuel');
  });

  it('classifies an unbranded check statement as a generic bank statement, naming no bank it cannot see', () => {
    // Bank-specific statement filename codes are personal and no longer hardcoded here, so a
    // statement that names no bank must fall back honestly rather than guess one.
    const res = ruleBasedClassify('RELEVE DE CHEQUES COMPTE 00000000000000000000', 'STMT_CHK_101_20100607.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('releve_bancaire');
  });

  it('resolves that same unbranded statement to the configured bank once the private overlay supplies the code', () => {
    const overlay = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['STMT_CHK_'], category: 'bank', subcategory: 'my_bank' }],
    });
    const res = ruleBasedClassify('RELEVE DE CHEQUES COMPTE 00000000000000000000', 'STMT_CHK_101_20100607.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST, overlay);
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('my_bank');
  });

  it('recognises a statement whose ONLY signal is an overlay filename code, with no generic statement phrasing', () => {
    const overlay = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['STMT_CHK_'], category: 'bank', subcategory: 'my_bank' }],
    });
    const res = ruleBasedClassify('COMPTE 00000000000000000000 solde 1234', 'STMT_CHK_101_20100607.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST, overlay);
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('my_bank');
  });

  it('never lets a non-bank overlay rule outrank a bank statement (Golden Rule #6 archetypal trap)', () => {
    // A landlord / vendor name appearing only inside a statement's transaction rows must not
    // pull the document out of 'bank' — the same trap the generic flow guards against.
    const overlay = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['Northwind Realty'], category: 'housing', subcategory: 'northwind' }],
    });
    const res = ruleBasedClassify(
      'RELEVE DE COMPTE CREDIT MUTUEL solde crediteur\n12/03 PRLV Northwind Realty loyer -750,00',
      'statement_202403.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST,
      overlay
    );
    expect(res.categorie).toBe('bank');
    expect(res.subcategorie).toBe('credit_mutuel');
  });

  it('applies that same non-bank overlay rule normally when the document is NOT a bank statement', () => {
    const overlay = PromptPersonalizationSchema.parse({
      priority_rules: [{ keywords: ['Northwind Realty'], category: 'housing', subcategory: 'northwind' }],
    });
    const res = ruleBasedClassify('Quittance de loyer Northwind Realty mars 2024', 'quittance.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST, overlay);
    expect(res.categorie).toBe('housing');
    expect(res.subcategorie).toBe('northwind');
  });

  it('correctly classifies academic transcripts (relevés de notes)', () => {
    const res = ruleBasedClassify('Relevé de notes semestriels et trimestriels Université', 'relevés de notes semestriels ou trimestriels.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
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

describe('buildEntityHintLine document filter (prompt budget)', () => {
  const DICT = dictionaryWith({
    banks: [
      { slug: 'credit_mutuel', name: 'Credit Mutuel', aliases: ['ccm'] },
      { slug: 'bnp_paribas', name: 'BNP Paribas', aliases: ['bnp'] },
    ],
  });

  it('lists only the entities the document actually mentions', () => {
    // Unfiltered, all ~1,000 dictionary entities went into every prompt for every category:
    // 88% of the category description and ~19k tokens against a num_ctx of 8192, so most of the
    // decision flow was truncated away before the model read it.
    const hint = buildEntityHintLine('bank', DICT, 'RELEVE DE COMPTE CREDIT MUTUEL solde crediteur');
    expect(hint).toContain('credit_mutuel');
    expect(hint).not.toContain('bnp_paribas');
  });

  it('matches on an alias as well as the full name', () => {
    expect(buildEntityHintLine('bank', DICT, 'operation ccm du 12/03')).toContain('credit_mutuel');
  });

  it('emits nothing when the document names no known entity', () => {
    expect(buildEntityHintLine('bank', DICT, 'Attestation de residence Paris')).toBe('');
  });

  it('still lists everything when no document text is supplied (unchanged callers)', () => {
    const hint = buildEntityHintLine('bank', DICT);
    expect(hint).toContain('credit_mutuel');
    expect(hint).toContain('bnp_paribas');
  });
});

// The substring pre-filter + per-dictionary memo replaced "build ~2,700 RegExp objects on every
// call" (2,092ms for the first full-dictionary call). These pin the behaviours that refactor could
// plausibly have broken: the pre-filter must be case-insensitive the same way the 'i' flag is, the
// memo must not leak results between different dictionaries, and reuse must not accumulate state.
describe('matchEntityDictionary — pre-filter and per-dictionary memoization', () => {
  it('still matches when the document text is uppercase and the entity name is not', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'bnp_paribas', name: 'BNP Paribas', aliases: [] }] });
    expect(matchEntityDictionary('RELEVE DE COMPTE BNP PARIBAS AGENCE', ['banks'], dict))
      .toEqual({ categorie: 'bank', subcategorie: 'bnp_paribas' });
  });

  it('returns the same answer on repeated calls with the same dictionary object', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'lcl', name: 'LCL', aliases: [] }] });
    const first = matchEntityDictionary('virement lcl agence', ['banks'], dict);
    const second = matchEntityDictionary('virement lcl agence', ['banks'], dict);
    const miss = matchEntityDictionary('aucune banque ici', ['banks'], dict);
    expect(first).toEqual({ categorie: 'bank', subcategorie: 'lcl' });
    expect(second).toEqual(first);   // memo reuse must not corrupt the result
    expect(miss).toBeNull();         // ...nor leak a previous hit into a non-matching document
  });

  it('does not serve one dictionary\'s entities to another dictionary', () => {
    const dictA = dictionaryWith({ banks: [{ slug: 'lcl', name: 'LCL', aliases: [] }] });
    const dictB = dictionaryWith({ banks: [{ slug: 'cic', name: 'CIC', aliases: [] }] });
    expect(matchEntityDictionary('virement lcl agence', ['banks'], dictA)).toEqual({ categorie: 'bank', subcategorie: 'lcl' });
    expect(matchEntityDictionary('virement lcl agence', ['banks'], dictB)).toBeNull();
    expect(matchEntityDictionary('virement cic agence', ['banks'], dictB)).toEqual({ categorie: 'bank', subcategorie: 'cic' });
  });

  it('keeps word-boundary correctness for a candidate that survives the substring pre-filter', () => {
    // 'taxaphone' contains 'axa', so the cheap includes() pre-filter passes it through — the
    // compiled boundary regex is what must still reject it.
    const dict = dictionaryWith({ insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }] });
    expect(matchEntityDictionary('societe taxaphone service', ['insurance'], dict)).toBeNull();
    expect(matchEntityDictionary('contrat axa 2024', ['insurance'], dict)).toEqual({ categorie: 'insurance', subcategorie: 'axa' });
  });
});
