import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';
import fs from 'fs';

vi.mock('fs');

const { generateMock, listMock, pullMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
  pullMock: vi.fn(),
}));

vi.mock('ollama', () => ({
  // NOTE: must be a regular `function`, not an arrow function — classify-document.ts calls
  // `new Ollama(...)`, and arrow functions can never be used as constructors in JS.
  // An arrow-function implementation throws "is not a constructor" under `new`.
  Ollama: vi.fn().mockImplementation(function () {
    return {
      generate: generateMock,
      list: listMock,
      pull: pullMock,
    };
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe('classifyPDFText', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    // The module-level `afterEach(() => vi.resetAllMocks())` (see top of file) also wipes the
    // hoisted `Ollama` constructor's `.mockImplementation(...)` set up in the `vi.mock('ollama', ...)`
    // factory above — resetAllMocks() clears implementations, not just call history, on every
    // mock function, including this one. Without re-establishing it here, `new Ollama(...)` inside
    // classify-document.ts would return a bare `{}` (mock constructors with no implementation just
    // return `this` under `new`), so `.generate`/`.list`/`.pull` would be undefined and every test
    // below would silently fall through to the ruleBasedClassify catch-path instead of exercising Ollama.
    vi.mocked(Ollama).mockImplementation(function () {
      return {
        generate: generateMock,
        list: listMock,
        pull: pullMock,
      } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false); // categories.json/entity_dictionary.json absent -> built-in defaults
    listMock.mockResolvedValue({ models: [{ name: 'qwen3.5:9b' }] });
  });

  // With the modular micro-prompt pipeline, every document (regardless of length) makes at least
  // 4 Ollama `generate()` calls in order: (1) the health probe from `checkModelCanGenerate`,
  // (2) Step A's entity extraction, (3) Step C's markdown conversion (one call per chunk — a
  // single chunk for documents under ~1400 chars), (4) Step D's classification.

  it('requests think:false from Ollama — regression guard for the 2026-07-30 bug where the model routed its whole JSON answer into response.thinking and left response.response empty', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe (checkModelCanGenerate)
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: '', document_type: '' }) }) // Step A
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: '', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 's', tags: [],
        }),
      }); // Step D
    const { classifyPDFText } = await import('./classify-document.js');
    await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(generateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ think: false }));
    expect(generateMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ think: false }));
  });

  it('parses a valid JSON response into DocumentMetadata (happy path)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'SFR', document_type: 'Invoice' }) }) // Step A
      .mockResolvedValueOnce({ response: '# SFR\n\nFacture Total TTC 45.99' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: 'REF-1', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 'A vendor invoice',
          tags: ['sfr'],
        }),
      }); // Step D
    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
    expect(result.titre).toBe('Facture SFR');
  });

  it('falls back to ruleBasedClassify when Step D returns an empty response.response (the pre-fix failure shape)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: '', document_type: '' }) }) // Step A succeeds but finds nothing
      .mockResolvedValueOnce({
        response: '',
        thinking: JSON.stringify({ titre: 'Facture SFR', categorie: 'invoices', subcategorie: 'sfr' }),
      }); // Step D: unparseable — classifyPDFText never reads response.thinking
    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    // This only resolves correctly via the outer try/catch falling back to ruleBasedClassify,
    // which independently recognizes 'sfr' + 'total ttc'.
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
  });

  it('does not special-case a classification-shaped Step A response — Step D always runs independently (regression guard for the removed "test mock" branch code smell)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      // Step A response malformed/shaped like a full classification instead of {issuing_entity, document_type} —
      // the old code special-cased exactly this shape and returned it directly, skipping Step D entirely.
      .mockResolvedValueOnce({ response: JSON.stringify({ titre: 'Wrong Shape', categorie: 'invoices', subcategorie: 'sfr' }) })
      .mockResolvedValueOnce({ response: '# Bulletin de salaire EmployeurX' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Bulletin de Salaire', registre: '', date: '2024-05-01',
          categorie: 'bulletin_salaire', subcategorie: 'employeur_x', summary: 's', tags: [],
        }),
      }); // Step D — the real classification result that must win
    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('Bulletin de salaire EmployeurX', 'bulletin.pdf');
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('employeur_x');
    expect(result.titre).toBe('Bulletin de Salaire');
    expect(generateMock).toHaveBeenCalledTimes(4); // health + Step A + Step C + Step D — Step D was NOT skipped
  });

  it('prioritizes Step A\'s grounded entity over Step D\'s wrong fallback category (Crédit Mutuel bank-statement regression)', async () => {
    // Serve a minimal entity_dictionary.json with a "credit_mutuel" bank entry, keeping
    // categories.json absent (built-in defaults, which already include a 'bank' category).
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('entity_dictionary.json'));
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('entity_dictionary.json')) {
        return JSON.stringify({
          banks: [{ slug: 'credit_mutuel', name: 'Crédit Mutuel', aliases: ['credit mutuel', 'ccm'] }],
          energy: [], telecom: [], insurance: [], gov: [], health: []
        });
      }
      return '';
    });

    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({
        response: JSON.stringify({ issuing_entity: 'CAISSE DE CREDIT MUTUEL MARSEILLE STE MARGUERITE', document_type: 'Bank Statement' })
      }) // Step A correctly identifies the bank
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Relevé bancaire', registre: '', date: '2024-05-01',
          categorie: 'reports', subcategorie: 'credit_mutuel_marseille_ste_marguerite',
          summary: 's', tags: [],
        }),
      }); // Step D still gets the top-level category wrong — 'reports' mirrors the actual output
      // observed against this real document during manual probing (scratch/latency_probe.ts),
      // confirming the fix must not be scoped to only the 'correspondence' fallback category.

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText(
      'RELEVE DE COMPTE Caisse de Crédit Mutuel Marseille Ste Marguerite IBAN FR76 0000 0000 0000',
      'releve.pdf'
    );

    expect(result.categorie).toBe('bank');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('does NOT override a specific (non-fallback) Step D category even when the entity is dictionary-grounded elsewhere (e.g. France Travail issuing a pay slip, not an administrative letter)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('entity_dictionary.json'));
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('entity_dictionary.json')) {
        return JSON.stringify({
          banks: [], energy: [], telecom: [], insurance: [],
          gov: [{ slug: 'france_travail', name: 'France Travail', aliases: ['france travail', 'pole emploi'] }],
          health: []
        });
      }
      return '';
    });

    generateMock
      .mockResolvedValueOnce({ response: 'ok' })
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'France Travail', document_type: 'Pay Slip' }) })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Bulletin ARE', registre: '', date: '2024-05-01',
          categorie: 'bulletin_salaire', subcategorie: 'france_travail', summary: 's', tags: [],
        }),
      });

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('Bulletin de salaire France Travail Net à payer', 'are.pdf');

    // 'bulletin_salaire' is not a weak/fallback category, so Step D's own (correct) read wins.
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('france_travail');
  });

  it('surfaces subcategorie="general" verbatim for a short document with an ungrounded AI subcategory guess, so the downstream Golden Rule #4 BLOCK guard has something to catch', async () => {
    const shortText = 'Illegible scan content, no identifiable entity here at all in this short snippet.';
    expect(shortText.length).toBeLessThan(800);

    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: '', document_type: '' }) }) // Step A: nothing extracted
      .mockResolvedValueOnce({ response: '# Scan\n\nIllegible scan content, no identifiable entity here at all in this short snippet.' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Scan', registre: '', date: '',
          categorie: 'correspondence', subcategorie: 'randomgibberish123', // ungrounded — not in text or filename
          summary: '', tags: [],
        }),
      }); // Step D

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText(shortText, 'IMG_0001.pdf');

    // classifyPDFText's contract: an ungrounded subcategory must resolve to the literal string
    // 'general', never be silently smoothed over into some other value — the caller (triage-scan.ts)
    // is the one that actually BLOCKs the file per Golden Rule #4 when it sees this.
    expect(result.subcategorie).toBe('general');
  });

  it('runs Step C (markdown conversion) even for short documents instead of skipping it below 800 chars — regression guard for real invoices (e.g. a 724-char Bouygues Telecom facture) being stored as raw unconverted text', async () => {
    const shortText = 'SFR Facture Total TTC 45.99';
    expect(shortText.length).toBeLessThan(800);

    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'SFR', document_type: 'Invoice' }) }) // Step A
      .mockResolvedValueOnce({ response: '# SFR\n\n**Total TTC:** 45.99€' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: '', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 's', tags: [],
        }),
      }); // Step D

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText(shortText, 'facture.pdf');

    expect(generateMock).toHaveBeenCalledTimes(4); // health + Step A + Step C + Step D
    expect(result.markdown_content).toBe('# SFR\n\n**Total TTC:** 45.99€');
  });
});
