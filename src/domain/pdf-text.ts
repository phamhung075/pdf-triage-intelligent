export function cleanExtractedText(text: string, filename?: string): string {
  if (!text || text.trim().length < 10) {
    return '';
  }
  return text
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Corrupted-text detection (bad embedded font / missing ToUnicode CMap) ---
//
// Symptom (confirmed on real data — doc id 2545, a Vietnamese balance sheet
// whose PDF font has no valid ToUnicode CMap): pdf-parse returns non-empty
// text that LOOKS like real words but individual characters have been
// substituted, producing a single random UPPERCASE letter in the middle of
// an otherwise-lowercase short word — e.g. "BANG cAN oor xf roAN" instead of
// "BẢNG CÂN ĐỐI KẾ TOÁN", "khAu" instead of "khấu", "NguyAn" instead of
// "Nguyễn". Normal French/English/Vietnamese prose essentially never produces
// this pattern except for rare brand names (iPhone, McDonald's) or CamelCase
// word-concatenation artifacts from column/cell extraction (e.g.
// "SociétéGénérale", "polystyrèneTache") — both of which are excluded below.
//
// Calibration (see scratch/calibrate-v6.cjs, run against all 662 documents
// in pdf_triage.db as of 2026-08-12):
//   - A naive whole-document ratio does NOT separate doc 2545 from clean
//     documents: the corruption is localized to a few pages (the balance-
//     sheet tables) inside a 78k-char / ~10.8k-word document, so it gets
//     diluted to a whole-document ratio of ~1%, well within the range of
//     ordinary documents (CamelCase-glued bank statement column headers sit
//     at 2-4%). A SLIDING WINDOW over the word stream is required to find
//     the localized burst.
//   - CamelCase multi-word concatenation (e.g. "polystyrèneTache",
//     "SociétéGénéraleBDDF") produces the same "uppercase not at position 0"
//     symptom but glues together multiple real (usually 8+ char) words.
//     Capping word length at 8 chars removes this false-positive class
//     almost entirely, since the per-character substitution corruption seen
//     in doc 2545 produces short monosyllabic-length garbled tokens.
//   - Requiring EXACTLY ONE uppercase letter (not two or more) additionally
//     filters CamelCase concatenations of 2+ words, which usually carry 2+
//     capitals.
//   - With word length capped at 2-8 chars, a 100-word sliding window
//     (50-word step), and a window flagged only once it has BOTH a ratio
//     >= 0.08 AND at least 6 matching words, doc 2545 comes out on top of
//     the entire corpus (window ratio 0.12, 12/100) with zero genuine false
//     positives among clean documents (their best window never reaches the
//     6-match floor at all). The next-highest scorers that do clear the bar
//     (a Bouygues Telecom invoice with "opÈrateur"/"payÈe" mojibake, and an
//     EDF invoice with letter-by-letter vertical-text extraction) are
//     themselves genuinely corrupted/garbled extractions that legitimately
//     benefit from the same OCR fallback chain.

const CORRUPTION_WORD_MIN_LEN = 2;
const CORRUPTION_WORD_MAX_LEN = 8;
const CORRUPTION_WINDOW_SIZE = 100;
const CORRUPTION_WINDOW_STEP = 50;
const CORRUPTION_MIN_WINDOW_WORDS = 60; // 60% of CORRUPTION_WINDOW_SIZE — ignore short trailing windows
const CORRUPTION_MIN_ABS_MATCHES = 6;
const CORRUPTION_MIN_RATIO = 0.08;

export interface CorruptionSignal {
  corrupted: boolean;
  /** Ratio of mid-word-capitalized tokens in the worst window found (0 if no window qualifies). */
  ratio: number;
  /** Absolute count of mid-word-capitalized tokens in the worst window. */
  matchCount: number;
  /** A few example tokens from the worst window, for debug logging. */
  sampleWords: string[];
}

function isMidWordCapitalized(word: string): boolean {
  if (word.length < CORRUPTION_WORD_MIN_LEN || word.length > CORRUPTION_WORD_MAX_LEN) return false;
  const upperMatches = word.match(/\p{Lu}/gu) || [];
  return upperMatches.length === 1 && !/^\p{Lu}/u.test(word);
}

/**
 * Detects the "bad embedded font / missing ToUnicode CMap" corruption symptom:
 * a localized burst of short words with a single stray mid-word capital
 * (e.g. "cAn", "roAN", "khAu"). See the calibration notes above.
 */
export function detectMidWordCapitalizationCorruption(text: string): CorruptionSignal {
  const none: CorruptionSignal = { corrupted: false, ratio: 0, matchCount: 0, sampleWords: [] };
  if (!text) return none;

  const words = text.match(/\p{L}+/gu) || [];
  const eligible = words.filter(w => w.length >= CORRUPTION_WORD_MIN_LEN && w.length <= CORRUPTION_WORD_MAX_LEN);
  if (eligible.length < CORRUPTION_MIN_WINDOW_WORDS) return none;

  let best: CorruptionSignal = none;
  for (let i = 0; i < eligible.length; i += CORRUPTION_WINDOW_STEP) {
    const window = eligible.slice(i, i + CORRUPTION_WINDOW_SIZE);
    if (window.length < CORRUPTION_MIN_WINDOW_WORDS) continue;

    const flagged = window.filter(isMidWordCapitalized);
    const ratio = flagged.length / window.length;
    if (flagged.length >= CORRUPTION_MIN_ABS_MATCHES && ratio >= CORRUPTION_MIN_RATIO && ratio > best.ratio) {
      best = { corrupted: true, ratio, matchCount: flagged.length, sampleWords: flagged.slice(0, 5) };
    }
  }
  return best;
}

/**
 * True when `text` shows the localized mid-word-capitalization pattern typical
 * of a PDF font with a broken/missing ToUnicode CMap (garbled-but-nonempty
 * text that would otherwise sail past the "< 10 chars" empty-text guard).
 */
export function isLikelyCorruptedText(text: string): boolean {
  return detectMidWordCapitalizationCorruption(text).corrupted;
}

// A scanned PDF often still carries a *thin* digital text layer — the scanner app's watermark, a
// page number, a fax header. The extraction gate only asked whether the text was empty or shorter
// than 10 characters, so any of those counted as "usable digital text" and OCR never ran. A real
// example from the archive: an 8-page employment attestation whose entire raw_text was
// "Scanned with AnyScanner" repeated eight times — 198 characters, and none of the document's
// actual content in the registry, the classifier, or the Markdown.
//
// Two independent symptoms, both requiring at least 2 pages. Single-page documents are excluded on
// purpose: a certificate or a cover page is legitimately sparse, and forcing OCR on those would buy
// nothing but OCR time.
export const THIN_TEXT_MIN_CHARS_PER_PAGE = 100;
export const THIN_TEXT_MIN_PAGES = 2;
/** At or below this many distinct non-blank lines, a multi-page text layer may be boilerplate. */
export const THIN_TEXT_MAX_DISTINCT_LINES = 2;
/**
 * ...but only if that distinct content is also SHORT. A watermark is a handful of words; a document
 * that genuinely repeats a long line on every page still carries real text, and forcing it through
 * OCR would buy nothing but OCR time.
 */
export const THIN_TEXT_MAX_DISTINCT_CHARS = 200;
/**
 * The density rule needs its own version of that guard, or it fires on a document that is simply
 * SHORT rather than un-extracted — and the penalty for a false positive is real: a full pdfjs pass
 * plus up to OCR_MAX_PAGES canvas renders and OCR round-trips, all to re-derive text already in
 * hand. Vocabulary is what separates the two: an un-extracted scan leaks only page furniture
 * (a watermark, "Page 3", a fax header), so its few characters are also the same few words.
 *
 * Measured over the 274 archived documents: the two genuinely starved ones carry 0.4 and 4.8
 * distinct words per page, while normal multi-page documents sit at a 5th-percentile of 18.9.
 * 10 splits that gap with room on both sides.
 */
export const THIN_TEXT_MAX_DISTINCT_WORDS_PER_PAGE = 10;

export interface ThinTextLayerSignal {
  thin: boolean;
  charsPerPage: number;
  distinctLines: number;
  distinctWordsPerPage: number;
  /** Which symptom fired — for the log line, so a human can tell density from boilerplate. */
  reason: 'low-density' | 'repeated-boilerplate' | null;
}

export function detectThinTextLayer(text: string, numpages: number): ThinTextLayerSignal {
  const clean = (text || '').trim();
  const pages = Math.max(1, numpages || 1);
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const distinctLines = new Set(lines).size;
  const charsPerPage = clean.length / pages;
  // Accent-aware so French text ("société", "prénom") counts as words rather than fragments, and
  // ≥3 letters so page furniture ("p", "de", digits) does not inflate the vocabulary.
  const distinctWords = new Set(clean.toLowerCase().match(/[a-zà-ÿ]{3,}/g) || []).size;
  const distinctWordsPerPage = distinctWords / pages;
  const none: ThinTextLayerSignal = { thin: false, charsPerPage, distinctLines, distinctWordsPerPage, reason: null };

  if (pages < THIN_TEXT_MIN_PAGES) return none;
  if (!clean) return none; // empty text is already handled by the plain "< 10 chars" guard

  // Every page repeating the same one or two SHORT lines is a watermark/header, not content.
  const distinctChars = [...new Set(lines)].join('').length;
  if (
    lines.length >= pages &&
    distinctLines <= THIN_TEXT_MAX_DISTINCT_LINES &&
    distinctChars <= THIN_TEXT_MAX_DISTINCT_CHARS
  ) {
    return { thin: true, charsPerPage, distinctLines, distinctWordsPerPage, reason: 'repeated-boilerplate' };
  }

  // Sparse AND vocabulary-poor. Both halves are required: a short-but-real document has few
  // characters yet varied words, and dragging it through OCR would cost minutes to learn nothing.
  if (
    charsPerPage < THIN_TEXT_MIN_CHARS_PER_PAGE &&
    distinctWordsPerPage < THIN_TEXT_MAX_DISTINCT_WORDS_PER_PAGE
  ) {
    return { thin: true, charsPerPage, distinctLines, distinctWordsPerPage, reason: 'low-density' };
  }

  return none;
}
