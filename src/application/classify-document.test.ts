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
      .mockResolvedValueOnce({ response: '# Bulletin de salaire AcmeCorp' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Bulletin de Salaire', registre: '', date: '2024-05-01',
          categorie: 'bulletin_salaire', subcategorie: 'acme_corp', summary: 's', tags: [],
        }),
      }); // Step D — the real classification result that must win
    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('Bulletin de salaire AcmeCorp', 'bulletin.pdf');
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('acme_corp');
    expect(result.titre).toBe('Bulletin de Salaire');
    expect(generateMock).toHaveBeenCalledTimes(4); // health + Step A + Step C + Step D — Step D was NOT skipped
  });

  it('corrects a future-dated "date" field from Step D when it conflicts with the titre\'s stated year (doc #2472 regression — OCR "30/11/26" misread as 2026 instead of 2025)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe
      .mockResolvedValueOnce({ response: JSON.stringify({ issuing_entity: 'Lakeside Dental', document_type: 'Pay Slip' }) }) // Step A
      .mockResolvedValueOnce({ response: '# Bulletin de salaire Novembre 2025' }) // Step C
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Bulletin de salaire - Novembre 2025', registre: '', date: '30/11/2026',
          categorie: 'bulletin_salaire', subcategorie: 'lakeside_dental', summary: 's', tags: [],
        }),
      }); // Step D — same OCR-misread future date the real Ollama model produced for doc #2472
    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText('Poriodo: Novonbro 2025 Paiemont lo 30/11/26', 'bulletin.pdf', undefined, new Date('2026-08-12T00:00:00'));
    expect(result.date).toBe('2025-11-30');
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
        response: JSON.stringify({ issuing_entity: 'CAISSE DE CREDIT MUTUEL SPRINGFIELD CENTRE', document_type: 'Bank Statement' })
      }) // Step A correctly identifies the bank
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Relevé bancaire', registre: '', date: '2024-05-01',
          categorie: 'reports', subcategorie: 'credit_mutuel_springfield_centre',
          summary: 's', tags: [],
        }),
      }); // Step D still gets the top-level category wrong — 'reports' mirrors the actual output
      // observed against this real document during manual probing (scratch/latency_probe.ts),
      // confirming the fix must not be scoped to only the 'correspondence' fallback category.

    const { classifyPDFText } = await import('./classify-document.js');
    const result = await classifyPDFText(
      'RELEVE DE COMPTE Caisse de Crédit Mutuel Springfield Centre IBAN FR76 0000 0000 0000',
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

describe('convertRawTextToZeroLossMarkdown — Problem B continuation across chunk boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return {
        generate: generateMock,
        list: listMock,
        pull: pullMock,
      } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false); // prompt files absent -> built-in fallback templates
  });

  // convertRawTextToZeroLossMarkdown only calls requestTextChatCompletion (one ollama.generate()
  // per chunk) — no health probe, no Step A/D — so each mocked generate call below corresponds
  // 1:1 to a chunk index.
  function buildMultiChunkRawText(): string {
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`Line ${i}: padding content to push this document past the 1400-char chunk boundary for testing purposes.`);
    }
    return lines.join('\n');
  }

  it('threads the previous chunk\'s open-table header/separator into the next chunk\'s prompt as continuation context', async () => {
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);
    expect(chunks.length).toBeGreaterThanOrEqual(2); // sanity: this raw text really does span >1 chunk

    const openTableMarkdown = [
      '## Transactions',
      '',
      '| Date | Amount | Label |',
      '| --- | --- | --- |',
      '| 2024-05-01 | 100.00 | Salaire |',
    ].join('\n');

    generateMock.mockResolvedValueOnce({ response: openTableMarkdown }); // chunk 1: ends mid-table
    for (let i = 1; i < chunks.length; i++) {
      generateMock.mockResolvedValueOnce({ response: '| 2024-05-02 | 200.00 | Loyer |' }); // continuing rows
    }

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(rawText, 'payroll.pdf');

    expect(generateMock).toHaveBeenCalledTimes(chunks.length);

    // The second call's prompt (chunk 2) must carry the continuation context detected from chunk 1's output.
    const secondCallArgs = generateMock.mock.calls[1][0];
    expect(secondCallArgs.prompt).toContain('⚠️ CONTINUATION CONTEXT:');
    expect(secondCallArgs.prompt).toContain('| Date | Amount | Label |');
    expect(secondCallArgs.prompt).toContain('| --- | --- | --- |');
    expect(secondCallArgs.prompt).toMatch(/do NOT repeat the header\/separator row/i);
  });

  it('does not inject continuation context when the previous chunk does not end mid-table', async () => {
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < chunks.length; i++) {
      generateMock.mockResolvedValueOnce({ response: `## Section ${i + 1}\n\nJust prose, no table here.` });
    }

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(rawText, 'letter.pdf');

    const secondCallArgs = generateMock.mock.calls[1][0];
    expect(secondCallArgs.prompt).not.toContain('⚠️ CONTINUATION CONTEXT:');
  });

  it('logs a debug line identifying the chunk index and detected header when continuation context is passed forward', async () => {
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const openTableMarkdown = [
      '| Ref | Montant |',
      '| --- | --- |',
      '| A1 | 50.00 |',
    ].join('\n');
    generateMock.mockResolvedValueOnce({ response: openTableMarkdown });
    for (let i = 1; i < chunks.length; i++) {
      generateMock.mockResolvedValueOnce({ response: '| A2 | 75.00 |' });
    }

    const { logger } = await import('../infrastructure/logger.js');
    const debugSpy = vi.spyOn(logger, 'debug');

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(rawText, 'notice.pdf');

    expect(debugSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringMatching(/ends mid-table.*Ref \| Montant/),
      expect.objectContaining({ filename: 'notice.pdf', chunkIndex: 1, nextChunkIndex: 2 })
    );
  });

  it('logs an info line when a chunk\'s converted output contains the illegible-fragment marker', async () => {
    generateMock.mockResolvedValueOnce({
      response: '> ⚠️ [Illegible fragment — preserved as-is]\nBANG cAN oor xf roAN garbled OCR noise',
    });

    const { logger } = await import('../infrastructure/logger.js');
    const infoSpy = vi.spyOn(logger, 'info');

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown('BANG cAN oor xf roAN garbled OCR noise', 'garbled.pdf');

    expect(infoSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringContaining('illegible-fragment marker'),
      expect.objectContaining({ filename: 'garbled.pdf', chunkIndex: 1 })
    );
  });
});

// Step C promises the model "ZERO CONTENT SKIPPING" (prompts/micro_prompt_markdown.md rule 1), and
// the empty/too-short branch honours that by keeping the raw chunk when the model gives nothing
// usable. The throw branch used to increment fallbackCount WITHOUT pushing the chunk, so any chunk
// whose ollama call rejected (timeout, socket reset, model unloaded mid-run) was deleted outright:
// a 4-chunk document came back as chunks 1,3,4 with no error surfaced to the caller. That is how
// six archived France Travail / Pole Emploi documents ended up with markdown_content at 6-14% of
// their raw_text. These tests pin the fallback so a dropped chunk can never silently return.
describe('convertRawTextToZeroLossMarkdown — no chunk is ever silently dropped', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return {
        generate: generateMock,
        list: listMock,
        pull: pullMock,
      } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  function buildMultiChunkRawText(): string {
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`SENTINEL ${i}: padding content to push this document past the 1400-char chunk boundary for testing purposes.`);
    }
    return lines.join('\n');
  }

  it('keeps the raw chunk when the model call throws, instead of deleting it', async () => {
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // Chunk 2 rejects; every other chunk converts normally.
    chunks.forEach((_, i) => {
      if (i === 1) generateMock.mockRejectedValueOnce(new Error('simulated ollama timeout'));
      else generateMock.mockResolvedValueOnce({ response: `## Converted chunk ${i + 1}` });
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    const md = await convertRawTextToZeroLossMarkdown(rawText, 'timeout.pdf');

    // The failed chunk's own text must survive verbatim in the output.
    for (const line of chunks[1].split('\n')) {
      if (line.trim()) expect(md).toContain(line.trim());
    }
    // ...and the surrounding converted chunks must still be there, in order.
    expect(md.indexOf('## Converted chunk 1')).toBeLessThan(md.indexOf(chunks[1].split('\n')[0].trim()));
    expect(md).toContain(`## Converted chunk ${chunks.length}`);
  });

  it('preserves every chunk even when every single model call throws', async () => {
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);

    chunks.forEach(() => generateMock.mockRejectedValueOnce(new Error('ollama down')));

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    const md = await convertRawTextToZeroLossMarkdown(rawText, 'alldown.pdf');

    // Full raw-text fallback: nothing converted, but nothing lost either.
    for (let i = 1; i <= 60; i++) expect(md).toContain(`SENTINEL ${i}:`);
  });

  it('warns rather than debug-logs when a chunk falls back, so the degradation is visible in the log', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rawText = buildMultiChunkRawText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);

    chunks.forEach((_, i) => {
      if (i === 1) generateMock.mockRejectedValueOnce(new Error('simulated ollama timeout'));
      else generateMock.mockResolvedValueOnce({ response: `## Converted chunk ${i + 1}` });
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(rawText, 'timeout.pdf');

    expect(warnSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringContaining('conversion failed'),
      expect.objectContaining({ filename: 'timeout.pdf', chunkIndex: 2 })
    );
    warnSpy.mockRestore();
  });
});

// A real archived document exposed this: "Déclaration fiscale annuelle_20260130.pdf" extracted to
// 590,166 chars across only 320 lines — 153 of those lines longer than the 1400-char chunk budget,
// the longest 13,860 chars. chunkText appended each over-long line whole, so a single chunk carried
// ~14k chars into a model whose num_predict caps the RESPONSE at 4096 tokens. The reply came back
// truncated but non-empty, sailed past the `length > 10` success gate as "converted", and the
// document was stored with markdown_content at 6% of raw_text (33,189 vs 590,166) — content loss
// with no throw, no fallback, and nothing in the log. Chunks must respect the budget.
describe('chunkText — no chunk may exceed the budget, even from one long line', () => {
  it('splits a single line that is longer than the chunk size', async () => {
    const { chunkText } = await import('./classify-document.js');
    const oneLongLine = 'mot '.repeat(4000).trim(); // 15,999 chars, no newlines at all
    const chunks = chunkText(oneLongLine, 1400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1400);
  });

  it('loses no words when splitting a long line', async () => {
    const { chunkText } = await import('./classify-document.js');
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(' '), 1400);
    const rejoined = chunks.join(' ').split(/\s+/).filter(Boolean);
    expect(rejoined).toEqual(words); // every word, in order, exactly once
  });

  it('splits at whitespace rather than mid-word when it can', async () => {
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(Array.from({ length: 400 }, () => 'lorem').join(' '), 200);
    for (const c of chunks) {
      expect(c.startsWith('lorem')).toBe(true);
      expect(c.endsWith('lorem')).toBe(true); // no half-words at the seams
    }
  });

  it('still respects the budget for an unbroken run with no whitespace at all', async () => {
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText('x'.repeat(5000), 1400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1400);
    expect(chunks.join('')).toBe('x'.repeat(5000)); // hard cut, but nothing dropped
  });

  it('leaves normal short-line text chunked exactly as before', async () => {
    const { chunkText } = await import('./classify-document.js');
    const text = Array.from({ length: 60 }, (_, i) => `Line ${i}: ordinary content here.`).join('\n');
    const chunks = chunkText(text, 1400);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1400);
    // every original line still present
    for (let i = 0; i < 60; i++) expect(chunks.join('\n')).toContain(`Line ${i}:`);
  });
});

// num_predict caps the RESPONSE at 4096 tokens. When generation stops there, ollama reports
// done_reason 'length' and the markdown is cut off mid-chunk — long, plausible, and incomplete.
// Step C discarded done_reason, so the `length > 10` gate accepted the truncated text as
// "converted" and everything after the cut was lost with no error and no fallback.
describe('convertRawTextToZeroLossMarkdown — a truncated model response is not a conversion', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return { generate: generateMock, list: listMock, pull: pullMock } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  function multiChunkText(): string {
    return Array.from({ length: 60 }, (_, i) => `TRUNCMARK ${i}: padding content to push this document past the 1400-char chunk boundary.`).join('\n');
  }

  it('keeps the raw chunk when generation stopped at the output limit', async () => {
    const rawText = multiChunkText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);

    chunks.forEach((_, i) => {
      if (i === 1) generateMock.mockResolvedValueOnce({ response: '## Converted but cut off mid-sen', done_reason: 'length' });
      else generateMock.mockResolvedValueOnce({ response: `## Converted chunk ${i + 1}`, done_reason: 'stop' });
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    const md = await convertRawTextToZeroLossMarkdown(rawText, 'truncated.pdf');

    expect(md).not.toContain('cut off mid-sen');           // the truncated output is discarded
    for (const line of chunks[1].split('\n')) {
      if (line.trim()) expect(md).toContain(line.trim());  // ...and the full raw chunk kept instead
    }
  });

  it('warns so the truncation is visible in the log', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rawText = multiChunkText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);

    chunks.forEach((_, i) =>
      generateMock.mockResolvedValueOnce(
        i === 0 ? { response: '## cut', done_reason: 'length' } : { response: `## ok ${i}`, done_reason: 'stop' }
      )
    );

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(rawText, 'truncated.pdf');

    expect(warnSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringContaining('done_reason=length'),
      expect.objectContaining({ filename: 'truncated.pdf', chunkIndex: 1 })
    );
    warnSpy.mockRestore();
  });

  it('accepts a normal completion untouched', async () => {
    const rawText = multiChunkText();
    const { chunkText } = await import('./classify-document.js');
    const chunks = chunkText(rawText, 1400);
    chunks.forEach((_, i) => generateMock.mockResolvedValueOnce({ response: `## Converted chunk ${i + 1}`, done_reason: 'stop' }));

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    const md = await convertRawTextToZeroLossMarkdown(rawText, 'fine.pdf');
    expect(md).toContain('## Converted chunk 1');
    expect(md).not.toContain('TRUNCMARK'); // fully converted, no raw fallback
  });
});

// Ragged tables were completely invisible: the only way to find the Bouygues call-detail tables
// filing each call's cost under "Unité(s) décomptée(s)" was to audit the database afterwards.
// Step C now measures the assembled markdown and says so in the log.
describe('convertRawTextToZeroLossMarkdown — reports table integrity problems', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return { generate: generateMock, list: listMock, pull: pullMock } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('warns when the assembled markdown has rows short of their header', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    generateMock.mockResolvedValueOnce({
      response: [
        '| Date | Heure | Numéro | Unités | Coût |',
        '|:---|:---|:---|:---|:---|',
        '| 12/08 | 11:53:37 | 336528710 | 0,00 |',
        '| 12/08 | 11:54:33 | 336528710 | 0,00 |',
      ].join('\n'),
      done_reason: 'stop',
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown('short raw text', 'facture.pdf');

    expect(warnSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringContaining('Table integrity problems'),
      expect.objectContaining({ filename: 'facture.pdf', raggedRows: 2, dataRows: 2 })
    );
    warnSpy.mockRestore();
  });

  it('stays quiet for a well-formed table', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    generateMock.mockResolvedValueOnce({
      response: ['| Date | Coût |', '| --- | --- |', '| 12/08 | 1,00 |'].join('\n'),
      done_reason: 'stop',
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown('short raw text', 'clean.pdf');

    const tableWarnings = warnSpy.mock.calls.filter(c => String(c[1]).includes('Table integrity'));
    expect(tableWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// The two table symptoms are independent, and the warning must not assert one while reporting the
// other: a document with headerless blocks but zero ragged rows was being told "those rows' values
// are shifted into the wrong columns" about no rows at all.
describe('convertRawTextToZeroLossMarkdown — the table warning states only what it found', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return { generate: generateMock, list: listMock, pull: pullMock } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('does not mention shifted values when no row is ragged', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // A headerless continuation block only — every row well-formed, no header above them.
    generateMock.mockResolvedValueOnce({
      response: ['| 12/08 | 11:53 | 0,00 |', '| 13/08 | 12:01 | 0,00 |'].join('\n'),
      done_reason: 'stop',
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown('short raw text', 'orphan.pdf');

    const call = warnSpy.mock.calls.find(c => String(c[1]).includes('Table integrity'));
    expect(call).toBeDefined();
    expect(String(call![1])).toContain('no header at all');
    expect(String(call![1])).not.toContain('shifted into the wrong columns');
    expect(String(call![1])).not.toContain('(0%)');
    warnSpy.mockRestore();
  });

  it('does not mention headerless blocks when there are none', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    generateMock.mockResolvedValueOnce({
      response: ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 |'].join('\n'),
      done_reason: 'stop',
    });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown('short raw text', 'ragged.pdf');

    const call = warnSpy.mock.calls.find(c => String(c[1]).includes('Table integrity'));
    expect(call).toBeDefined();
    expect(String(call![1])).toContain('shifted into the wrong columns');
    expect(String(call![1])).not.toContain('no header at all');
    warnSpy.mockRestore();
  });
});

// Step C promises ZERO CONTENT SKIPPING and, until this check, nothing verified it: bank statements
// dropped transaction payee names and a closing balance while every card reference on the same rows
// survived, discoverable only by diffing the database by hand.
describe('convertRawTextToZeroLossMarkdown — reports content that did not survive', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    vi.mocked(Ollama).mockImplementation(function () {
      return { generate: generateMock, list: listMock, pull: pullMock } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  const a = 'abcdefghijklmnopqrstuvwxyz';
  const distinctWords = (n: number) =>
    Array.from({ length: n }, (_, i) => `libelle${a[i % 26]}${a[Math.floor(i / 26) % 26]}${a[(i * 5) % 26]}`).join(' ');

  it('warns when a large share of raw content tokens is absent from the markdown', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const raw = distinctWords(60);
    // Model returns only the first handful of words — the rest are dropped.
    generateMock.mockResolvedValue({ response: raw.split(' ').slice(0, 10).join(' '), done_reason: 'stop' });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(raw, 'statement.pdf');

    expect(warnSpy).toHaveBeenCalledWith(
      'OLLAMA_AI',
      expect.stringContaining('Content preservation below threshold'),
      expect.objectContaining({ filename: 'statement.pdf' })
    );
    warnSpy.mockRestore();
  });

  it('stays quiet when the markdown keeps everything', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const raw = distinctWords(60);
    generateMock.mockResolvedValue({ response: `# Title\n\n${raw}`, done_reason: 'stop' });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(raw, 'clean.pdf');

    const hits = warnSpy.mock.calls.filter(c => String(c[1]).includes('Content preservation'));
    expect(hits).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('does not warn on run-together raw text even when recall is low, because the claim cannot be made', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    // Measurable (the fusion guard does not trip) but the text carries camel-case seams — the exact
    // shape of the BNP RLV_CHQ_* statements that produced ~10 false warnings an hour.
    const raw = `${distinctWords(60)} DateNature valeurDebit soldeCrediteur`;
    generateMock.mockResolvedValue({ response: distinctWords(60).split(' ').slice(0, 10).join(' '), done_reason: 'stop' });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(raw, 'fused-statement.pdf');

    expect(warnSpy.mock.calls.filter(c => String(c[1]).includes('Content preservation'))).toHaveLength(0);
    // ...but it is still recorded, so an audit can find it.
    expect(debugSpy.mock.calls.filter(c => String(c[1]).includes('Low token recall'))).not.toHaveLength(0);
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('does not warn on fused raw text, where de-fusing legitimately loses raw tokens', async () => {
    const { logger } = await import('../infrastructure/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const fused = 'Jemepermetsdevousadressermacandidature '.repeat(30);
    generateMock.mockResolvedValue({ response: 'Je me permets de vous adresser ma candidature.', done_reason: 'stop' });

    const { convertRawTextToZeroLossMarkdown } = await import('./classify-document.js');
    await convertRawTextToZeroLossMarkdown(fused, 'lettre.pdf');

    const hits = warnSpy.mock.calls.filter(c => String(c[1]).includes('Content preservation'));
    expect(hits).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
