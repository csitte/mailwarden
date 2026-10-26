import { describe, it, expect } from "vitest";
import { decodeCharset, fixWindows1252Controls } from "../src/charset.js";

// Node 20's TextDecoder reads the windows-1252 label (and every label WHATWG maps to it, such
// as iso-8859-1) as plain ISO-8859-1: 0x80..0x9f come back as C1 control characters instead of
// the euro sign, typographic quotes and dashes. Seen in CI on 26 Oct 2026; Node 22 is right.
describe("fixWindows1252Controls", () => {
  it("maps the C1 range to the characters windows-1252 puts there", () => {
    expect(fixWindows1252Controls("\u0080 \u0084Hallo\u0093 \u0096 \u0097 \u0085 \u0099")).toBe("€ „Hallo“ – — … ™");
  });

  it("leaves the five positions windows-1252 does not define as they are", () => {
    expect(fixWindows1252Controls("\u0081\u008d\u008f\u0090\u009d")).toBe("\u0081\u008d\u008f\u0090\u009d");
  });

  it("is idempotent and leaves everything else alone", () => {
    const s = "Grüße € „x“ – plain";
    expect(fixWindows1252Controls(s)).toBe(s);
  });
});

describe("decodeCharset", () => {
  const cp1252 = Buffer.from([0x80, 0x20, 0x84, 0x78, 0x93, 0x20, 0x96, 0x20, 0xfc]);

  it("decodes windows-1252 bytes right on every Node", () => {
    expect(decodeCharset(cp1252, "windows-1252")).toBe("€ „x“ – ü");
  });

  it("treats iso-8859-1 and latin1 as windows-1252, as WHATWG and mail clients do", () => {
    expect(decodeCharset(cp1252, "iso-8859-1")).toBe("€ „x“ – ü");
    expect(decodeCharset(cp1252, "latin1")).toBe("€ „x“ – ü");
  });

  it("does not touch other charsets", () => {
    expect(decodeCharset(Buffer.from("€ ü", "utf8"), "utf-8")).toBe("€ ü");
    // ISO-8859-15 has the euro at 0xa4; nothing in the C1 range is rewritten for it
    expect(decodeCharset(Buffer.from([0xa4]), "iso-8859-15")).toBe("€");
  });

  it("throws on an unknown label, like TextDecoder, so callers keep their fallback", () => {
    expect(() => decodeCharset(Buffer.from("x"), "x-no-such-charset")).toThrow(RangeError);
  });
});
