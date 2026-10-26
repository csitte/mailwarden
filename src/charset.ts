/**
 * Decoding bytes by a charset label, with one correction TextDecoder needs on Node 20.
 *
 * WHATWG maps iso-8859-1, latin1, us-ascii and windows-1252 to one decoder, windows-1252, which
 * puts the euro sign, typographic quotes and dashes at 0x80..0x9f. Node 20's TextDecoder returns
 * C1 control characters there instead (seen in CI on 26 Oct 2026; Node 22 is right). Outlook
 * labels its mail iso-8859-1 or windows-1252 and uses exactly those characters, so the gap is
 * filled here. On a Node that decodes correctly nothing is left in that range to rewrite.
 */

// windows-1252 at 0x80..0x9f; 0x81, 0x8d, 0x8f, 0x90 and 0x9d are undefined and stay as they are.
const C1_TO_CP1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Replace C1 control characters by the windows-1252 characters at the same byte. Pure. */
export function fixWindows1252Controls(s: string): string {
  return s.replace(/[\u0080-\u009f]/g, (c) => String.fromCharCode(C1_TO_CP1252[c.charCodeAt(0) - 0x80]));
}

/** Decode `bytes` by `label`. Throws RangeError for an unknown label, as TextDecoder does. */
export function decodeCharset(bytes: Uint8Array, label: string): string {
  const decoder = new TextDecoder(label);
  const text = decoder.decode(bytes);
  return decoder.encoding === "windows-1252" ? fixWindows1252Controls(text) : text;
}
