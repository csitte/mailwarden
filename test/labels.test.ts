import { describe, it, expect } from "vitest";
import { canCarryColor, labelColorHint, resolveLabelColor, PALETTE_DOC } from "../src/labels.js";
import { ToolError } from "../src/cli.js";

describe("resolveLabelColor", () => {
  it("returns undefined when no colour was asked for", () => {
    expect(resolveLabelColor()).toBeUndefined();
    expect(resolveLabelColor(undefined, undefined)).toBeUndefined();
  });

  it("builds the pair Gmail expects", () => {
    expect(resolveLabelColor("#fb4c2f", "#ffffff")).toEqual({
      backgroundColor: "#fb4c2f",
      textColor: "#ffffff",
    });
  });

  it("normalises case, because hex digits carry no meaning beyond their value", () => {
    expect(resolveLabelColor("#FB4C2F", "#FFFFFF")).toEqual({
      backgroundColor: "#fb4c2f",
      textColor: "#ffffff",
    });
  });

  it.each([
    ["only a background", "#fb4c2f", undefined],
    ["only a text colour", undefined, "#ffffff"],
  ])("refuses %s — Gmail needs both halves", (_what, bg, fg) => {
    expect(() => resolveLabelColor(bg, fg)).toThrow(ToolError);
    expect(() => resolveLabelColor(bg, fg)).toThrow(/together/);
  });

  it.each([
    ["missing hash", "fb4c2f"],
    ["three-digit shorthand", "#f4f"],
    ["eight digits with alpha", "#fb4c2fff"],
    ["a colour name", "red"],
    ["empty", ""],
    ["trailing space", "#fb4c2f "],
  ])("refuses a %s value", (_what, bad) => {
    expect(() => resolveLabelColor(bad, "#ffffff")).toThrow(/hex colour/);
    expect(() => resolveLabelColor("#ffffff", bad)).toThrow(/hex colour/);
  });

  it("names the offending field, so a caller knows which half to fix", () => {
    expect(() => resolveLabelColor("nope", "#ffffff")).toThrow(/backgroundColor must be/);
    expect(() => resolveLabelColor("#ffffff", "nope")).toThrow(/textColor must be/);
  });

  it("classifies its refusals as invalid_input, not an internal error", () => {
    try {
      resolveLabelColor("#fb4c2f");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid_input");
    }
  });

  /**
   * The palette is Gmail's to enforce. Two published lists of it disagree — Google's reference
   * documents 102 values, taylorwilsdon/google_workspace_mcp carries 113, and the documented set
   * is a strict subset — so a filter here would either refuse colours Gmail accepts or promise
   * ones it refuses. These two values sit in that disputed gap and must pass: whether they work
   * is between the caller and Gmail.
   */
  it.each(["#007286", "#d93025"])("passes %s through — the palette is Gmail's to enforce", (c) => {
    expect(resolveLabelColor(c, "#ffffff")).toEqual({ backgroundColor: c, textColor: "#ffffff" });
  });

  it("points at the documented palette in every refusal", () => {
    expect(labelColorHint()).toContain(PALETTE_DOC);
    expect(() => resolveLabelColor("#fb4c2f")).toThrow(new RegExp(PALETTE_DOC.slice(8, 40)));
  });
});

describe("canCarryColor", () => {
  it("allows user labels", () => {
    expect(canCarryColor("user")).toBe(true);
  });

  it("refuses Gmail's own labels", () => {
    expect(canCarryColor("system")).toBe(false);
  });

  it("allows an unknown type rather than guessing a refusal", () => {
    // listLabels leaves `type` undefined when Gmail omits it. Refusing on absent
    // information would block a legitimate call to spare an API round-trip.
    expect(canCarryColor(undefined)).toBe(true);
    expect(canCarryColor(null)).toBe(true);
  });
});
