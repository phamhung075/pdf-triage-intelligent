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
//
//   - Unit-token exception (real data — doc id 5009, an EDF régularisation
//     invoice triaged 2026-09-03): "kW"/"kWh"/"kVA" legitimately carry exactly
//     one uppercase letter not at position 0 (lowercase SI prefix + uppercase
//     unit), and an energy bill packs them densely enough in its tariff tables
//     and footnotes to cross the window bar (14/100 = 14% in one window). The
//     digital layer of that invoice was CLEAN ("Mlle PALMA BRIGITTE", accents
//     intact), yet it was flagged corrupted, discarded, and replaced by a
//     full-page OCR pass that mangled names, addresses and accents ("MIe PALMA
//     BRI G TTE", "LE GALOI S", "Du lundi aū samedi"). Unlike brand names,
//     units are a repeatable vocabulary, so they are excluded via an explicit
//     allowlist (isUnitLikeToken) BEFORE the windowing step — frequency alone
//     cannot separate them, since a genuinely broken CMap also repeats tokens.

const CORRUPTION_WORD_MIN_LEN = 2;
const CORRUPTION_WORD_MAX_LEN = 8;
const CORRUPTION_WINDOW_SIZE = 100;
const CORRUPTION_WINDOW_STEP = 50;
const CORRUPTION_MIN_WINDOW_WORDS = 60; // 60% of CORRUPTION_WINDOW_SIZE — ignore short trailing windows
const CORRUPTION_MIN_ABS_MATCHES = 6;
const CORRUPTION_MIN_RATIO = 0.08;

/**
 * Tokens that legitimately look "mid-word-capitalized" but are real SI-unit
 * abbreviations — a lowercase prefix letter (kilo, milli, hecto, …) followed by
 * an uppercase unit symbol: kW, kWh, kVA, kPa, hPa, dBm, mA, mSv, …
 *
 * A genuine per-character CMap corruption never produces these exact words —
 * its tokens are mangled source words ("khAu", "cAn", "roAN"), not units — so
 * an explicit allowlist removes the energy-invoice false-positive class (EDF
 * doc 5009, see calibration notes above) without weakening the symptom
 * detector. Keep it exact: a structural rule (e.g. "lowercase prefix + one
 * uppercase") would also swallow real corruption tokens like "cAn".
 */
const UNIT_LIKE_TOKENS: ReadonlySet<string> = new Set([
  'kW', 'kWh', 'kVA', 'kWc', 'kWp', 'kVAr', 'kVar', 'kV', 'kB',
  'kHz', 'kPa', 'hPa', 'cSt', 'dBm', 'cGy', 'mGy', 'mSv',
  'mV', 'mA', 'mW', 'mAh', 'mΩ', 'kΩ', 'μA', 'μW', 'µA', 'µW',
]);

/** True when `word` is a known unit abbreviation that only *looks* corrupted. */
export function isUnitLikeToken(word: string): boolean {
  return UNIT_LIKE_TOKENS.has(word);
}

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
  // Unit abbreviations (kW/kWh/kVA/…) are excluded up front so they count
  // neither as corruption evidence nor as window filler (see calibration notes).
  const eligible = words.filter(
    w => w.length >= CORRUPTION_WORD_MIN_LEN &&
      w.length <= CORRUPTION_WORD_MAX_LEN &&
      !isUnitLikeToken(w)
  );
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

// --- OCR vs digital-layer arbitration ("keep the better candidate") ---
//
// The corruption guard above routes a flagged digital layer through OCR because OCR is the right
// remedy for a GENUINELY broken ToUnicode CMap. But the guard can misfire (doc id 5009: a clean
// EDF layer dense with SI units), and when it does, blindly overwriting the layer with OCR output
// destroys text that was already perfect — "Mlle PALMA BRIGITTE" became "MIe PALMA BRI G TTE".
// So whenever OCR runs on a corruption-triggered path, the caller arbitrates between the two
// candidates instead of assuming OCR won. These helpers are that arbitration, kept pure so the
// decision is unit-testable without any OCR round-trip.

export interface TextQualityMetrics {
  /** Higher = more prose-like. Roughly average token length minus short-token penalties. */
  score: number;
  /** Number of letter tokens the score was computed over (0 for empty text). */
  tokens: number;
  avgTokenLength: number;
  /** Share of tokens 1-2 letters long. OCR band/decoration noise is almost all such tokens. */
  shortTokenShare: number;
  /** Share of tokens that are a single isolated letter. */
  singleLetterShare: number;
}

/**
 * Cheap, language-agnostic "is this text real prose or OCR noise?" estimate. It exists only to
 * reject obviously degraded OCR (line noise, isolated letters, single-character runs), not to
 * judge translation quality: clean prose scores high, while band/decoration noise like
 * "S S8 S 5 T S S S8 S S S8 S - 8 Sd S te 0-Z S0 2 S0 e de e" collapses to near zero.
 */
export function scoreTextQuality(text: string): TextQualityMetrics {
  const tokens = (text || '').match(/\p{L}+/gu) || [];
  const count = tokens.length;
  if (count === 0) {
    return { score: -1, tokens: 0, avgTokenLength: 0, shortTokenShare: 0, singleLetterShare: 0 };
  }
  const sum = tokens.reduce((acc, t) => acc + t.length, 0);
  const avgTokenLength = sum / count;
  const short = tokens.filter(t => t.length <= 2).length;
  const single = tokens.filter(t => t.length === 1).length;
  const shortTokenShare = short / count;
  const singleLetterShare = single / count;
  // Weights calibrated on real samples: clean French prose ~5.0+, the doc-5009 OCR output ~2.5,
  // pure band noise below 1.0.
  const score = avgTokenLength - 1.5 * singleLetterShare - 0.4 * shortTokenShare;
  return { score, tokens: count, avgTokenLength, shortTokenShare, singleLetterShare };
}

export type ExtractionChoiceReason =
  | 'clean-layer-kept' // the digital layer passes the corruption detector — never replace it
  | 'ocr-unusable' // OCR empty/too short, or still corrupted — keep the original
  | 'ocr-not-prose' // OCR output looks like noise, not words — keep the original
  | 'ocr-clean-recovery'; // the layer was genuinely corrupted and OCR recovered prose — prefer OCR

export interface ExtractionChoice {
  text: string;
  source: 'digital' | 'ocr';
  reason: ExtractionChoiceReason;
}

/**
 * Decide between the digital text layer and a full-page OCR pass of the same document.
 *
 * The default bias is toward the LAYER: OCR only wins when (a) the layer is actually flagged
 * corrupted, (b) the OCR output is not itself corrupted, and (c) the OCR output looks like real
 * words rather than noise. Any other outcome keeps the original text — the harm of keeping a
 * genuinely corrupted layer (a later repair can re-OCR it) is smaller than the harm of replacing
 * a readable layer with OCR garbage, which is unrecoverable without the source file.
 */
export function chooseBestExtraction(originalText: string, ocrText: string): ExtractionChoice {
  const original = (originalText || '').trim();
  const ocr = (ocrText || '').trim();

  if (!ocr || ocr.length < 10) {
    return { text: original, source: 'digital', reason: 'ocr-unusable' };
  }
  if (!isLikelyCorruptedText(original)) {
    // The (unit-aware) detector cleared the layer. Whatever OCR says, a layer this clean must not
    // be replaced — this is the doc-5009 false-positive class caught at the source.
    return { text: original, source: 'digital', reason: 'clean-layer-kept' };
  }
  if (isLikelyCorruptedText(ocr)) {
    return { text: original, source: 'digital', reason: 'ocr-unusable' };
  }

  const quality = scoreTextQuality(ocr);
  const proseLike =
    quality.avgTokenLength >= 3.0 &&
    quality.singleLetterShare <= 0.4 &&
    quality.shortTokenShare <= 0.6;
  if (!proseLike) {
    return { text: original, source: 'digital', reason: 'ocr-not-prose' };
  }
  return { text: ocr, source: 'ocr', reason: 'ocr-clean-recovery' };
}
