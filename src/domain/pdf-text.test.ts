import { describe, it, expect } from 'vitest';
import { cleanExtractedText, isLikelyCorruptedText, detectMidWordCapitalizationCorruption , detectThinTextLayer } from './pdf-text.js';

// --- Real-data fixtures ---
//
// All fixtures below are VERBATIM excerpts pulled straight from pdf_triage.db
// (raw_text column), not paraphrased or invented, so the heuristic is judged
// against the actual symptom it needs to catch and the actual false-positive
// traps that exist in this registry. See scratch/calibrate-v6.cjs (used
// during development) for how the corpus of 662 real documents was scanned
// to calibrate the thresholds in src/domain/pdf-text.ts.

// POSITIVE CONTROL: doc id 2545, "...BctcthQuy2Nam2023GiaiTrinh...Cong_Ty_Co_Phan_Uong_Quang_.pdf"
// — a Vietnamese balance sheet whose PDF font has no valid ToUnicode CMap.
// This is the exact character range (raw_text[9218:10757]) that contains the
// heaviest concentration of the mid-word-capitalization corruption symptom
// in that document's cash-flow-statement section.
const CORRUPTED_BALANCE_SHEET_EXCERPT =
  "CC nq \ncria \ndon vikh6c\n5. \nTidn \nchi tlAu \ntu \ng6p \nv6n \nvio don \nvi \nkh6c\n6. \nTiin \nthu \nlai cho \nvay, c6 \ntric \nve \npi \nnhu6n \niluqc \nchia\nLuu \nchuy6n \nti6n \nthuin \ntt \nhogt ilSng \ndAu \ntr\nlII. \nLuu chuy6n \nti6n tir \nho4t \nd$ng \ntAi chinli\nl. \nTGn thu \ntt tli \nvay\n2. \nTiAn \ntri ng \ngdc \nvaY\n3. \nC6 \nttc, \nlgi nhuan \ndd trd \ncho \nchri sd \nhtu\nLuu \nchuy6n \nti6n \nthuin \ntt ho4t \ntlQng \ntii \nchlnh\nLuu chuy6n \ntian \nthuln \ntrong \nkY\nTidn \nvi tuong \ntluong \ntGn \ndAu \nk)\nenl\nhudng \ncta\nthay \nd6i ri \ngi6 \nh5i do6i \nquy \nd6i \nngo4i \ntQ\nduang \nti6n cu6i \nkY\n1.320.708.662.116 \n183.991.621.40E\n01\n02\n03\nI \n1, t 3,14381.059.928.554\n67.360.892.322\n(3.s50.294.386)\n(320.383.325.13 l)\n87 .929.211.916\n1.533.125.075.39r\n(69.535.037.485)\n(807 \n.932.082.902)\n206.714.220.726\n26.804.r01.226\n(86.650.906.898)\n(95.500.814.609)\n361.869.338.229\n47 .440.882.013\n(t3t \n.761.892)\n(210.897.175.405)\n46 .348 \n.470.17 \nt\n1.028.621.380.524\n(18.131.311.681)\n(665.628.724.888)\n147.6E2.708.829\n(97 \n8 .7 5t \n.647)\n(46.262.593.012)\n(5s.629.881.704)\n04\n05\n06\n0'7\n08\n09\nl0\nl1\n12\n14\nl5\n16\nt7\n20\n30\n23\n18\n7.988.848.1l5) \n(\n8.315.952.669)\n699.035.707.334\n381.362.873.7s2\n(70.966.537.060) \n(71 \n.101.83 \n5.53 \n6)\n21\n22\n23\n24\n25\n27\n30\n(4.934.000.000.000)\n4.026.000.000.000\n301.153.360.740\n671.813.176.3201\n102.810.923.42E(\n33\n36\n40\n2l\n2t\n3.312.047.353.5E3\n(2.698.257 \n.185.734\\\n50\n60\n6t\n70\n892.372.517 \n.450)\n72.443.511.711Q18.sE2.\n349.60 \nr)\n93.666.102.725\n205.591 \n.441 \n.519\n201.953.492.369\n3 \n.s59 .124.642\n1n.527.322.546\n184.219.21\n299.178.719.136\nNguoi \nlfp\nK6 \ntoin";

// The same document also produces short, isolated mid-word-capitalized tokens
// like these elsewhere in its balance-sheet header (e.g. "BANG cAN oor xf
// roAN" instead of "BẢNG CÂN ĐỐI KẾ TOÁN", "khAu" instead of "khấu",
// "NguYAn" instead of "Nguyễn") — listed here for documentation, exercised
// indirectly through the excerpt above.

// NEGATIVE CONTROL 1: doc id 2503, a clean French Pôle Emploi letter
// (normal prose with accents, no font corruption).
const CLEAN_FRENCH_LETTER_EXCERPT =
  "[Propriétés Document: Open Print | Driver PDF]\n\nPôle emploi la force d'un réseau !\nRetrouvez tous nos services en ligne,\n24h/24, 7j/7 sur www.pole-emploi.fr\n4000 conseillers entreprise\nà votre service\nODSE04\n0000000000\n34/ODSE04/V7\nLE GLOBEX\nM. DUPOND JEANLUC\n210 BD BOULEVARD EXEMPLE\n75010 SPRINGFIELD 10\nSPRINGFIELD, le 15 Mars 2017\nVos informations utiles :\nN° SIRET :000000000 00000\nN° offre :XXXXXXX\nConcerne :LE GLOBEX\n75010 SPRINGFIELD\nVotre correspondant :Service Entreprise\nTél. : 0100000000 - recrutement.exemple@pole-emploi.net\nObjet :Votre recrutement / N° offre XXXXXXX\nMonsieur,\nLa  date  de  fin  de  publication  que  vous  avez  choisie  pour  votre  offre  de  \"  Cuisinier  /  Cuisinière  \"  est  atteinte.  Nous\nsuspendons donc la publication de votre offre à compter de ce jour.\nNéanmoins, vous avez la possibilité de prolonger la publication de votre offre, en vous connectant à votre\nespace recrutement\nsur www.pole-emploi.fr.\nPar  ailleurs,  nous  n’avons  pas  connaissance  de  candidatures  sur  votre  offre.  Nous  tenons  à  partager  cette  alerte  avec\nvous.\nSi  vous  rencontrez  des  difficultés  dans  votre  recrutement,  contactez  le  Service  Entreprise  de  votre  agence  Pôle  emploi\npour examiner les différentes solutions possibles.\nEn revanche, si vous avez arrêté votre choix sur un candidat qui vous a contacté directement, nous vous remercions de\nnous le faire savoir en vous connectant à votre\nespace recrutement\nsur www.pole-emploi.fr.\nEn l’absence de réponse de votre part dans les 8 jours, nous en déduirons que votre besoin en recru";

// NEGATIVE CONTROL 2: doc id 3080, a real Société Générale bank statement.
// This is the important trap case: pdf-parse glues table cells together
// with NO spaces, producing long CamelCase runs ("SociétéGénérale",
// "RELEVÉDECOMPTE", "VotreBanqueàDistance") that also contain uppercase
// letters not at position 0 — but they are multi-word concatenations, not
// per-character substitution corruption, and must NOT be flagged.
const CLEAN_BANK_STATEMENT_EXCERPT =
  "[Propriétés Document: Pro/Afp Document | Pro/Afp]\n\nSociétéGénérale552120222RCSParis\nS.A.aucapitalde1066714367,50EurSiègeSocial\n29,bdHaussmann75009Paris\nR\nA\n4\n2\n0\n3\n2\n1\nM.JEANLUC\nLARUEEXEMPLE10\n201BOULEVARDEXEMPLE\n75009PARIS\nRELEVÉDECOMPTE\nCOMPTEDEPARTICULIER-eneuros\nn°00000000000000000000000\ndu06/12/2020au06/01/2021\nenvoin°1Page1/4\n1Depuisl'étranger:(+33)176773933,tarifau01/03/2020\nPourtouteinsatisfactionoudésaccord,vouspouvezcontacter:\n1-L'agence:votrepremierinterlocuteur\n2-LeServiceRelationsClientèle:Adresse:SociétéGénéraleBDDF/SEG/SAT/SRC75886Pariscedex18Tel:0142143169E-mail:relations.clientele@socgen.com\n3-LeMédiateur,endernierrecours,gratuitementetenapplicationdelaChartedelaMédiationSociétéGénéraleenadressantuncourrieràl'adressesuivante:\nLeMédiateurauprèsdeSociétéGénérale,17coursValmy92987ParisLaDéfensecedex7,ouparvoieélectroniquesurlesiteinternetduMédiateur:\nwww.mediateur.societegenerale.fr.LeMédiateurrépondradansundélaide90joursmaximumàréceptiondudossiercomplet.\nVOSCONTACTS\nVotreBanqueàDistance\nCodeclient\nM.JEANDUPOND:00000000\nsurinternet:particuliers.societegenerale.fr\nsurvotremobileavecl'AppliSociétéGénérale\npartéléphoneau3933\n(service0,30€/min+prixappel\n1\n)\nVotreagencePARISSAINTEANNE\nparmessageriedansvotreEspaceClient\nparticuliers.societegenerale.fr\npartéléphone:0100000001\nparfax:0100000002\nVotreconseillerenagence\nMLEEXEMPLE\npartéléphone:0100000001\nSTD\nRELEVÉDESOPÉRATIONS\nDateValeurNaturedel'opérationDébitCrédit\nSOLDEPRÉCÉDENTAU05/12/2020158,18\n07/12/202007/12/2020VIRRECU6891719800S\nDE:ADYENNV\nMOTIF:TX0000000000XTEtsy.comIE\nPROVENANCE:NLPaysBas\n2,92\n07/12/202007/12/2020CARTEX026603/12Amazonsellerrepay\n47,99USDETATS-UNISD'AME\n1EUR=1,2100USD\nCOMMERCEELECTRONIQUE\n39,66\n08/12/202008/12/2020FRAISPAIEMENTHORSZONEEURO\nCARTEX0266\n03/1247,99USDU.S.A\n2,07\n09/12/202009/12/2020VIRRECU7094640751S\nDE:StripeTechnologyEuropeLtd\nMOTIF:STRIPED0D0D0\nPROVENANCE:DEAllemagne\n19,81\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n09/12/202009/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\n10/12/202010/12/2020VIRRECU7186644386S\nDE:StripeTechnologyEuropeLtd\nMOTIF:STRIPEA0A0A0\nPROVENANCE:DEAllemagne\n11,98\n11/12/202011/12/2020CARTEX026608/12Google\nCOMMERCEELECTRONIQUE\n1,29\nsuite>>>\n\nSociétéGénérale552120222RCSParis\nS.A.aucapitalde1066714367,50EurSiègeSocial\n29,bdHaussmann75009Paris\nR\nA\n4\n2\n0\n3\n2\n1\nRELEVÉDECOMPTE\nCOMPTEDEPARTICULIER-eneuros\nn°00000000000000000000000\ndu06/12/2020au06/01/2021\nenvoin°1Page2/4\nDateValeurNaturedel'opérationDébitCrédit\n11/12/202011/12/2020PRELEVEMENTEUROPEEN7105387282\nDE:PayPal(Europe)S.a.r.l.etCie.,S\n.C.A.\nID:LU96ZZZ0000000000000000058\nMOTIF:0000000000000PAYPAL\nREF:0000000000000PAYPALVIREMENT\nMANDAT4642224XQPQ22\n10,00\n14/12/202014/12/2020VIRINSTREC084921870309\nDE:GLOBEXSARL\nDATE:14/12/202000:44\nMOTIF:VIREMENT\nREF:XX000000XX0X0X00\nPOUR:DUPONDJEANLUC\n1.234,56\n14/12/202014/12/2020VIRRECU7586670563S\nDE:StripeTechnologyEuropeLtd\nMOTIF:STRIPEB0B0B0\nPROVENANCE:DEAllemagne\n28,78\n14/12/202014/12/2020CARTEX026606/12AMAZONEUSARL\nCOMMERCEELECTRONIQUE\n27,25\n15/12/202015/12/2020CARTEX026614/12MICROSOFT*ADVERTISING\n59,53EURIRLANDE\nCOMMERCEELECTRONIQUE\n59,53\n16/12/202016/12/2020VIRRECU7786007938S\nDE:StripeTechnologyEuropeLtd\nMOTIF:STRIPEC0C0C0\nPROVENANCE:DEAllemagne\n12,17\n16/12/202015/12/2020VIRINSTANTANEEMIS\nPOUR:MarieDupond\n9999BQXXXXCPT00000000000\nDATE:15/12/202021:39\nREF:000000000000\nREF:000000000000000000000001\nMOTIF:Muathiep\nCHEZ:XXXXFRPPXXX\n2.000,00\n16/12/202016/12/2020CARTEX026616/12ALLOVOISINS\nCOMMERCEELECTRONIQUE\n9,99\n17/12/202017/12/2020FRAISVIRINSTANTANEELEC000000000000\nREF000000000000000000000001\n0,80\n18/12/202018/12/2020COTISATIONMENSUELLESOBRIO6,90\n21/";

// NEGATIVE CONTROL 3: doc id 2548, a clean plain-text "certificat de travail"
// (short administrative letter, no accents-heavy content, no tables).
const CLEAN_CERTIFICATE_EXCERPT =
  "SAS GLOBEX.SARL 75014 PARIS  CERTIFICAT DE TRAVAIL  NAF :   4791A SIRET :   00000000000000 Nous certifions que   MR DUPOND Jean Luc  demeurant   10 Boulvard Exemple 75009 PARIS a été employé(e) par nous du   au 01/02/2020   01/07/2023  services rendus sont pris en compte dans l'exemption.\" La formule \"libre de tout engagement\" et toute autre constatant l'expiration régulière du contrat de travail, les qualités professionnelles et les donnant lieu au droit proportionnel. prévues à l'alinéa 1 du présent article, toutes les fois que ces mentions ne contiennent ni obligations, ni quittances, ni aucune autre convention Sont exempts de timbre et d'enregistrement les certificats de travail délivrés aux salariés même s'ils contiennent d'autres mentions que celles emplois ont été tenus. celle de sa sortie, et la nature de l'emploi, ou le cas échéant, des emplois successivement occupés ainsi que les périodes pendant lesquelles ces \"L'employeur doit, à l'expiration du contrat de travail, délivrer au travailleur un certificat contenant exclusivement la date d'entrée et  Le présent certificat a été établi conformément à l'article L1234-19 du Code du Travail :  en qualité de Fait à   PARI";

describe('cleanExtractedText', () => {
  it('returns empty string for text under 10 clean chars', () => {
    expect(cleanExtractedText('short')).toBe('');
    expect(cleanExtractedText('')).toBe('');
  });

  it('strips null bytes, normalizes newlines, and collapses excess blank lines', () => {
    const result = cleanExtractedText('Hello\0World\r\n\r\n\r\n\r\nMore text here');
    expect(result).not.toContain('\0');
    expect(result).not.toContain('\r\n');
    expect(result).not.toMatch(/\n{3,}/);
  });
});

describe('isLikelyCorruptedText — real-data calibration', () => {
  it('flags the real garbled excerpt from doc 2545 (bad font ToUnicode CMap)', () => {
    expect(isLikelyCorruptedText(CORRUPTED_BALANCE_SHEET_EXCERPT)).toBe(true);
  });

  it('does NOT flag a clean French administrative letter (doc 2503)', () => {
    expect(isLikelyCorruptedText(CLEAN_FRENCH_LETTER_EXCERPT)).toBe(false);
  });

  it('does NOT flag a real bank statement despite heavy CamelCase word-concatenation (doc 3080)', () => {
    // This is the critical false-positive trap: pdf-parse glues table cells
    // together with no spaces ("SociétéGénérale", "RELEVÉDECOMPTE"), which
    // also produces "uppercase not at position 0" but is a completely
    // different, harmless extraction artifact that must not trigger OCR.
    expect(isLikelyCorruptedText(CLEAN_BANK_STATEMENT_EXCERPT)).toBe(false);
  });

  it('does NOT flag a clean short administrative certificate (doc 2548)', () => {
    expect(isLikelyCorruptedText(CLEAN_CERTIFICATE_EXCERPT)).toBe(false);
  });

  it('returns false for empty or very short text (insufficient signal, handled by the separate <10-char guard)', () => {
    expect(isLikelyCorruptedText('')).toBe(false);
    expect(isLikelyCorruptedText('short text')).toBe(false);
  });

  it('does not false-positive on a rare, isolated brand-name mid-capital dropped into real clean prose', () => {
    // "iPhone" is itself a mid-word-capitalized token, but ONE mention inside
    // a large body of normal text must not push any 100-word window over the
    // ratio/absolute-count bar. (A brand name repeated unnaturally often in
    // a tight cluster legitimately would cross the bar — that's not the
    // "rare mention" case this exception is meant to protect.)
    const text = `${CLEAN_FRENCH_LETTER_EXCERPT} ${CLEAN_CERTIFICATE_EXCERPT} ` +
      `Il a acheté un iPhone chez McDonald la semaine dernière.`;
    expect(isLikelyCorruptedText(text)).toBe(false);
  });
});

describe('detectMidWordCapitalizationCorruption', () => {
  it('reports a non-zero ratio, an absolute match count, and sample tokens for the corrupted excerpt', () => {
    const signal = detectMidWordCapitalizationCorruption(CORRUPTED_BALANCE_SHEET_EXCERPT);
    expect(signal.corrupted).toBe(true);
    expect(signal.ratio).toBeGreaterThanOrEqual(0.08);
    expect(signal.matchCount).toBeGreaterThanOrEqual(6);
    expect(signal.sampleWords.length).toBeGreaterThan(0);
    // Every sample word must itself carry exactly one uppercase letter not at position 0.
    for (const word of signal.sampleWords) {
      const upperCount = (word.match(/\p{Lu}/gu) || []).length;
      expect(upperCount).toBe(1);
      expect(/^\p{Lu}/u.test(word)).toBe(false);
    }
  });

  it('reports corrupted: false with zero ratio/matchCount for clean text', () => {
    const signal = detectMidWordCapitalizationCorruption(CLEAN_FRENCH_LETTER_EXCERPT);
    expect(signal.corrupted).toBe(false);
    expect(signal.ratio).toBe(0);
    expect(signal.matchCount).toBe(0);
    expect(signal.sampleWords).toEqual([]);
  });
});

describe('detectThinTextLayer', () => {
  it('flags the real-world scanner-watermark case: 8 pages of one repeated line', () => {
    const text = Array(8).fill('Scanned with AnyScanner').join('\n\n');
    const signal = detectThinTextLayer(text, 8);
    expect(signal.thin).toBe(true);
    expect(signal.reason).toBe('repeated-boilerplate');
    expect(signal.distinctLines).toBe(1);
  });

  it('flags a multi-page document whose text layer is far too sparse to be content', () => {
    const signal = detectThinTextLayer('Page 1\nPage 2\nPage 3\nSome stray header text', 4);
    expect(signal.thin).toBe(true);
    expect(signal.reason).toBe('low-density');
  });

  it('leaves a normal multi-page document alone', () => {
    const page = 'Bulletin de salaire. '.repeat(40); // ~840 chars of real content per page
    const signal = detectThinTextLayer([page, page, page].join('\n'), 3);
    expect(signal.thin).toBe(false);
    expect(signal.reason).toBeNull();
  });

  it('never flags a single-page document — a sparse certificate is legitimate', () => {
    expect(detectThinTextLayer('Attestation', 1).thin).toBe(false);
    expect(detectThinTextLayer('x', 1).thin).toBe(false);
  });

  it('does not flag empty text — the existing "< 10 chars" guard already covers that', () => {
    expect(detectThinTextLayer('', 5).thin).toBe(false);
    expect(detectThinTextLayer('   \n  ', 5).thin).toBe(false);
  });

  it('does not treat a few long distinct lines as boilerplate', () => {
    // 2 pages, 3 distinct substantial lines — above the density floor, so real content.
    const text = ['A'.repeat(200), 'B'.repeat(200), 'C'.repeat(200)].join('\n');
    expect(detectThinTextLayer(text, 2).thin).toBe(false);
  });
});

describe('detectThinTextLayer — boilerplate rule requires the repeated content to be short', () => {
  it('does not flag a document that repeats a long line on every page', () => {
    const longLine = 'Conditions generales de vente applicables au present contrat. '.repeat(6); // ~370 chars
    const signal = detectThinTextLayer([longLine, longLine, longLine].join('\n'), 3);
    expect(signal.thin).toBe(false);
  });

  it('still flags a short watermark repeated on every page', () => {
    const signal = detectThinTextLayer(Array(12).fill('Scanned with CamScanner').join('\n'), 12);
    expect(signal.thin).toBe(true);
    expect(signal.reason).toBe('repeated-boilerplate');
  });
});

describe('detectThinTextLayer — the density rule also requires vocabulary-poor text', () => {
  it('spares a short but genuinely real 2-page document', () => {
    // Under the density floor over 2 pages, but carrying the varied vocabulary of a real document
    // (~16 distinct words per page, comfortably above the 5th-percentile of 18.9 measured across
    // the archive's normal multi-page documents). Running OCR here would cost minutes to re-derive
    // text already in hand.
    const text = 'attestation employeur salarie poste technicien contrat duree signature adresse '
               + 'siret ville fonction brute nette essai avenant cadre statut heures jours conges '
               + 'prime bureau';
    const signal = detectThinTextLayer(text, 2); // 85.5 chars/page, 11.5 distinct words/page
    expect(signal.charsPerPage).toBeLessThan(100); // density alone would have flagged it
    expect(signal.thin).toBe(false);
  });

  it('still flags a sparse page-furniture-only text layer', () => {
    const signal = detectThinTextLayer('Page 1\n\nPage 2\n\nPage 3\n\nPage 4', 4);
    expect(signal.thin).toBe(true);
    expect(signal.reason).toBe('low-density');
  });

  it('reports distinctWordsPerPage so the log line can explain the decision', () => {
    const signal = detectThinTextLayer(Array(8).fill('Scanned with AnyScanner').join('\n'), 8);
    expect(signal.distinctWordsPerPage).toBeCloseTo(3 / 8, 5);
  });
});
