/**
 * JSON.parse that does not round the ids Direct hands out.
 *
 * Since Direct closed plain text ads, every ad added through the API is stored as a
 * комбинаторное объявление and gets a 64-bit id (1926766869946816190, checked live
 * 2026-11-12). A JavaScript number holds integers exactly only up to 2^53, so JSON.parse
 * turned it into 1926766869946816300, the tool printed the rounded value, and every
 * later call with it (ads.update, suspend, delete) answered 8800 «Объект не найден».
 *
 * An integer literal that a number cannot hold is therefore returned as a STRING with the
 * exact digits; Direct accepts ids as strings in requests. Everything a number can hold
 * (older ids, money in micros, counters) stays a number, so nothing else changes shape.
 */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text));
}

const DIGIT_0 = 48;
const DIGIT_9 = 57;
const QUOTE = 34;
const BACKSLASH = 92;
const MINUS = 45;

/** Wraps in quotes every integer literal outside the safe range; the rest is untouched. */
export function quoteUnsafeIntegers(text: string): string {
  // Nothing below 16 digits can be unsafe (2^53 has 16), and almost no answer has one.
  if (!/\d{16}/.test(text)) return text;
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      // A string: digits inside it are text, not a number.
      i++;
      while (i < text.length) {
        const s = text.charCodeAt(i);
        if (s === BACKSLASH) i += 2;
        else if (s === QUOTE) break;
        else i++;
      }
      i++;
      continue;
    }
    if (c === MINUS || (c >= DIGIT_0 && c <= DIGIT_9)) {
      const start = i;
      i++;
      // The whole number token, fraction and exponent included, so 1.5e300 is not cut in half.
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i++;
      const literal = text.slice(start, i);
      if (/^-?\d{16,}$/.test(literal) && !Number.isSafeInteger(Number(literal))) {
        out += `${text.slice(copied, start)}"${literal}"`;
        copied = i;
      }
      continue;
    }
    i++;
  }
  return copied === 0 ? text : out + text.slice(copied);
}
