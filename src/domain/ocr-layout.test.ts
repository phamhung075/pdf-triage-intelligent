import { describe, it, expect } from 'vitest';
import { layoutOcrLines, type OcrLineItem } from './ocr-layout.js';

function cell(text: string, x: number, y: number, width = 30, height = 20): OcrLineItem {
  return {
    text,
    poly: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]],
    score: 0.9,
  };
}

describe('layoutOcrLines', () => {
  it('orders items into visual rows (same y band) and left-to-right within each row', () => {
    // Physical layout:
    //   row 1 (y 100):  Base          Montant      8,60
    //   row 2 (y 200):  TVA           21,49
    // PaddleOCR returns boxes in detector order, so this arrives scrambled: row 2 first,
    // columns shuffled. The layout pass must rebuild the two visual lines.
    const items = [
      cell('21,49', 180, 200),
      cell('8,60', 380, 100),
      cell('Base', 20, 100),
      cell('TVA', 60, 200),
      cell('Montant', 300, 100),
    ];
    const result = layoutOcrLines(items);
    expect(result).toBe('Base  Montant  8,60\nTVA  21,49');
  });

  it('joins fragments of the same word/phrase with a single space when the gap is narrow', () => {
    // "Bonjour" (width 200, 7 chars → ~28.6 px/glyph) directly followed by "monsieur" 10px later
    // is one phrase; a single space keeps the words adjacent for the markdown model.
    const wide = cell('Bonjour', 10, 50, 200);
    const next = { ...cell('monsieur', 10 + 200 + 10, 50, 300), text: 'monsieur' };
    expect(layoutOcrLines([wide, next])).toBe('Bonjour monsieur');
  });

  it('returns null when any item lacks geometry — the caller keeps the flat text', () => {
    const items = [
      cell('Base', 20, 100),
      { text: 'no geometry', poly: null, score: null },
    ];
    expect(layoutOcrLines(items)).toBeNull();
  });

  it('returns null for malformed geometry', () => {
    const bad: OcrLineItem[] = [
      { text: 'bad', poly: [[0, 'NaN' as unknown as number]], score: null },
    ];
    expect(layoutOcrLines(bad)).toBeNull();
  });

  it('returns null for empty or item-less input', () => {
    expect(layoutOcrLines([])).toBeNull();
    expect(layoutOcrLines(null)).toBeNull();
    expect(layoutOcrLines(undefined)).toBeNull();
  });

  it('handles a single item by returning its trimmed text', () => {
    expect(layoutOcrLines([cell('  Facture  ', 10, 10, 100)])).toBe('Facture');
  });
});
