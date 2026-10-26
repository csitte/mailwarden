/**
 * RFC 2047 encoded-words, on their own so that pure modules (signals.ts) can read a decoded
 * display name without importing the API wrapper. `gmail.ts` re-exports `decodeRfc2047`.
 */

import { decodeCharset } from "./charset.js";

/** Decode the byte payload of one RFC 2047 encoded-word (B = base64, Q = quoted-printable-ish). */
function encodedWordBytes(encoding: string, data: string): Uint8Array {
  if (/b/i.test(encoding)) return Buffer.from(data, "base64");
  // Q encoding: `_` is space, `=XX` is a hex byte, everything else is literal ASCII.
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9a-f]{2}$/i.test(data.slice(i + 1, i + 3))) {
      out.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(data.charCodeAt(i));
  }
  return Uint8Array.from(out);
}

/**
 * Decode RFC 2047 encoded-words in a header value: `=?charset?B|Q?data?=`.
 * Non-ASCII Subject/From/To headers arrive from the Gmail API in this raw form —
 * without decoding, the model sees `=?UTF-8?B?...?=` gibberish instead of text.
 * An undecodable word (unknown charset, malformed data) is left as-is.
 */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  // Whitespace between two adjacent encoded-words is ignored (RFC 2047 §6.2).
  const joined = value.replace(/(\?=)[ \t\r\n]+(=\?)/g, "$1$2");
  // `charset*lang` (RFC 2231 language suffix) is allowed — strip the suffix.
  return joined.replace(
    /=\?([^?*\s]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g,
    (whole, charset: string, enc: string, data: string) => {
      try {
        return decodeCharset(encodedWordBytes(enc, data), charset);
      } catch {
        return whole;
      }
    },
  );
}
