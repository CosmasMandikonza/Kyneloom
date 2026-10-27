/**
 * The editorial number policy (KYN-16 review, blocker A).
 *
 * Numbers are CLAIMS. A verified number may only enter audience-facing text
 * through the deterministic compiler, which computes it from accepted source
 * records and allowlisted metric tools. Text a model or producer authors —
 * recap headlines, hypothesis prose, inference disclosures — is editorial
 * and must therefore be NUMBER-FREE: it may interpret, dramatize and
 * contextualize, but it may not assert quantities.
 *
 * This is a strict policy allowlist, not a heuristic fact-checker: any digit
 * or English number word in editorial text is rejected with the offending
 * token named, and the author is pointed at the verified-claim channel.
 */

/** Number tokens editorial text may never contain. */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
];

const NUMBER_WORD_PATTERN = new RegExp(`\\b(?:${NUMBER_WORDS.join('|')})\\b`, 'iu');
const DIGIT_PATTERN = /\d+(?:[.,]\d+)?/u;

/**
 * Returns the first unsupported numeric token in editorial text, or null.
 * Digits (maximal runs, decimals included) and English number words are both
 * reported by their literal form.
 */
export function findUnsupportedNumericToken(text: string): string | null {
  const digit = text.match(DIGIT_PATTERN);
  if (digit !== null) return digit[0];
  const word = text.match(NUMBER_WORD_PATTERN);
  if (word !== null) return word[0].toLowerCase();
  return null;
}

/** The policy sentence every rejection message points authors to. */
export const EDITORIAL_NUMBER_POLICY =
  'editorial text must be number-free: numbers are claims, and verified numbers enter audience-facing text only through the deterministic compiler';
