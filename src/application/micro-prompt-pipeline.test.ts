import { describe, it, expect } from 'vitest';
import { chunkText, detectOpenTableTail } from './classify-document.js';
import { sanitizeDocumentNoise } from '../infrastructure/pdf-extractor.js';
import { buildEntityExtractionPrompt, buildMarkdownConversionPrompt } from '../domain/prompt.js';

describe('Modular Micro-Prompt Pipeline & Utilities', () => {
  it('chunkText splits long text into sequential chunks without losing data', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`Line ${i}: This is sample document content row for testing chunking.`);
    }
    const fullText = lines.join('\n');
    expect(fullText.length).toBeGreaterThan(3000);

    const chunks = chunkText(fullText, 1000);
    expect(chunks.length).toBeGreaterThan(1);

    const reassembled = chunks.join('\n');
    expect(reassembled.replace(/\s+/g, ' ')).toEqual(fullText.replace(/\s+/g, ' '));
  });

  it('sanitizeDocumentNoise removes browser extension and PDF properties litter', () => {
    const rawWithLitter = `[Propriétés Document: chrome-extension___mhjfbmdgcfjbbpaeojofohoefgiehjai_edge_pdf_index.html | Jane Doe]
[OCR Extracted Text]
QPtmp000123
BULLETIN DE SALAIRE
SAS GLOBEX CONSEIL`;

    const cleaned = sanitizeDocumentNoise(rawWithLitter);
    expect(cleaned).not.toContain('[Propriétés Document:');
    expect(cleaned).not.toContain('[OCR Extracted Text]');
    expect(cleaned).not.toContain('QPtmp000123');
    expect(cleaned).toContain('BULLETIN DE SALAIRE');
    expect(cleaned).toContain('SAS GLOBEX CONSEIL');
  });

  it('buildEntityExtractionPrompt creates a focused Step A prompt', () => {
    const prompt = buildEntityExtractionPrompt('facture_sfr.pdf', 'SFR FACTURE N° 123456 Montant: 45.00€');
    expect(prompt.user).toContain('facture_sfr.pdf');
    expect(prompt.user).toContain('SFR FACTURE');
    expect(prompt.user).toContain('issuing_entity');
    expect(prompt.system).toContain('entity extraction');
  });

  it('buildMarkdownConversionPrompt creates a zero-loss Step C prompt', () => {
    const prompt = buildMarkdownConversionPrompt('Table row 1: 100€\nTable row 2: 200€');
    expect(prompt.user).toContain('ZERO CONTENT SKIPPING');
    expect(prompt.user).toContain('Table row 1: 100€');
    expect(prompt.system).toContain('zero skipping');
  });

  describe('detectOpenTableTail (Problem B: chunk-blind table splitting)', () => {
    it('detects a table that is still open at the end of the markdown, returning its header and separator', () => {
      const md = [
        '## Transactions',
        '',
        '| Date | Amount | Label |',
        '| --- | --- | --- |',
        '| 2024-05-01 | 100.00 | Salaire |',
        '| 2024-05-02 | 200.00 | Loyer |',
      ].join('\n');

      const result = detectOpenTableTail(md);
      expect(result).not.toBeNull();
      expect(result?.header).toBe('| Date | Amount | Label |');
      expect(result?.separator).toBe('| --- | --- | --- |');
    });

    it('returns null when the markdown does not end in a table row', () => {
      const md = '## Section\n\nSome closing paragraph, not a table.';
      expect(detectOpenTableTail(md)).toBeNull();
    });

    it('returns null when the last line is itself a separator row with no header/data above it', () => {
      const md = '| --- | --- |';
      expect(detectOpenTableTail(md)).toBeNull();
    });

    it('returns null when trailing pipe-delimited lines never resolve to a real GFM separator row', () => {
      const md = [
        '**Label:** value | still not a table',
        '| just one pipe-looking line |',
      ].join('\n');
      expect(detectOpenTableTail(md)).toBeNull();
    });

    it('ignores trailing blank lines when locating the last content line', () => {
      const md = [
        '| Date | Amount |',
        '| --- | --- |',
        '| 2024-05-01 | 100.00 |',
        '',
        '   ',
        '',
      ].join('\n');
      const result = detectOpenTableTail(md);
      expect(result).not.toBeNull();
      expect(result?.header).toBe('| Date | Amount |');
    });

    it('returns null for a self-contained table that closes with prose after it (not actually open)', () => {
      const md = [
        '| Date | Amount |',
        '| --- | --- |',
        '| 2024-05-01 | 100.00 |',
        '',
        'End of section.',
      ].join('\n');
      expect(detectOpenTableTail(md)).toBeNull();
    });
  });
});
