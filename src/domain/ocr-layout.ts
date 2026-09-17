// Reconstructs reading order (and line structure) from OCR engine geometry.
//
// Why: PaddleOCR (and Tesseract's output) return one detected text line per box, but the boxes
// come back in the DETECTOR's order, which is not guaranteed to be top-to-bottom, left-to-right —
// and a physical printed row split into several boxes (an address block, a table row) arrives as
// several disconnected lines. Downstream, the markdown conversion model (Step C) only ever sees
// the linear text, so a scrambled order is exactly what makes it invent label/value pairs (rule
// 2b of prompts/micro_prompt_markdown.md) or open a new table per line. When the OCR server gives
// us the quadrilateral of every text box, this module re-orders the boxes into visual rows
// (same vertical band = one text line) and left-to-right within each row, then joins each row into
// a single line. A row whose cells were split across boxes ("Mlle PALMA" | "BRIGITTE" | "LE
// GALOIS") becomes one line again, and the model no longer has to guess what was adjacent.
//
// Pure and zero-I/O: geometry in, text out. `layoutOcrLines` returns null when it cannot make a
// confident call (no items, missing geometry), so a caller can silently fall back to the engine's
// own flat text instead of degrading.

export interface OcrLineItem {
  text: string;
  /** Four (x, y) corners in image pixels, top-left origin, y increasing downward. Null when the
   * engine did not report geometry for this item. */
  poly: number[][] | null;
  score: number | null;
}

interface Box {
  item: OcrLineItem;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerY: number;
}

/** Median of the boxes' heights; rows closer together than this share a visual line. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Order OCR items into visual lines (same row → same output line, left-to-right; rows
 * top-to-bottom) so the downstream markdown model sees adjacency it can trust.
 *
 * Returns null when the layout cannot be trusted: no usable items, or ANY item without geometry —
 * mixing geometric and non-geometric items would re-order the former around the latter's
 * arbitrary position. Callers then keep the engine's flat text, which is exactly today's output.
 */
export function layoutOcrLines(items: OcrLineItem[] | null | undefined): string | null {
  if (!items || items.length === 0) return null;

  const boxes: Box[] = [];
  for (const item of items) {
    const text = (item?.text ?? '').trim();
    if (!text) continue;
    if (!Array.isArray(item.poly) || item.poly.length < 2) return null; // missing geometry → bail
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const point of item.poly) {
      const x = Number(point?.[0]);
      const y = Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null; // malformed geometry → bail
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    boxes.push({ item, left, right, top, bottom, centerY: (top + bottom) / 2 });
  }
  if (boxes.length === 0) return null;

  const medianHeight = median(boxes.map(b => b.bottom - b.top));
  const rowTolerance = Math.max(2, medianHeight * 0.6);

  // Cluster into rows by vertical centre, greedy over the top-to-bottom sorted order.
  const sorted = [...boxes].sort((a, b) => a.centerY - b.centerY);
  const rows: Box[][] = [];
  for (const box of sorted) {
    const current = rows.length > 0 ? rows[rows.length - 1] : null;
    if (current && box.centerY - current[0].centerY <= rowTolerance) {
      current.push(box);
    } else {
      rows.push([box]);
    }
  }

  const lines: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.left - b.left);
    let line = '';
    for (let i = 0; i < row.length; i++) {
      const box = row[i];
      if (i === 0) {
        line = box.item.text;
        continue;
      }
      const prev = row[i - 1];
      const gap = box.left - prev.right;
      // Average glyph width of the left item: its box width divided by its character count.
      const prevCharWidth = Math.max(1, (prev.right - prev.left) / Math.max(1, prev.item.text.length));
      // Wide gaps signal a real column boundary on a dense form/invoice row; use a double space so
      // the column split survives into raw_text for the markdown model (and a human reading FTS
      // results). Narrow gaps are the same word/phrase continuing.
      const separator = gap > prevCharWidth * 1.2 ? '  ' : ' ';
      line += separator + box.item.text;
    }
    lines.push(line.trim());
  }

  return lines.join('\n');
}
