import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — repo-only guard, plain .mjs with no type declarations
import {
  ALLOWED,
  LOCAL_ONLY,
  NO_SEND,
  SCOPE_ANCHOR,
  TIER_QUALIFIED,
  findScopeAnchoredClaims,
  isAllowed,
  splitSentences,
  staleAllowances,
  unknownClaims,
} from "../scripts/lib/send-claims.mjs";

/**
 * The no-send promise is this project's reason to exist, and its precise form is easy to
 * overstate: Google enforces it only for `gmail.readonly`, because it accepts `gmail.modify`
 * on `messages.send`. Saying "the scopes cannot send" has been written and shipped twice
 * (2026-08-13 across six files, 2026-08-26 in the Workspace-neighbour section) despite a rule
 * in CLAUDE.md forbidding it both times.
 *
 * So this is not a rule any more. Every scope-anchored no-send sentence in the repository has
 * to appear in `ALLOWED` with a reason, the way every Gmail endpoint has to appear in the
 * egress allow list. New wording fails until a human has read it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file whose prose can carry the promise — discovered, never enumerated by hand. */
function scannedFiles(): Record<string, string> {
  const rels: string[] = [];
  for (const f of readdirSync(ROOT)) {
    if (f.endsWith(".md") && f !== "CHANGELOG.md") rels.push(f);
  }
  for (const dir of ["docs", "src"]) {
    const abs = path.join(ROOT, dir);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith(".md") || f.endsWith(".ts")) rels.push(`${dir}/${f}`);
    }
  }
  return Object.fromEntries(rels.map((rel) => [rel, readFileSync(path.join(ROOT, rel), "utf8")]));
}

describe("send-claims: the net", () => {
  it("catches the wording that shipped in 0.15.0", () => {
    const s = "your setup authorizes with `gmail.readonly` or `gmail.modify` and has no compose path at all";
    expect(SCOPE_ANCHOR.test(s)).toBe(true);
    expect(NO_SEND.test(s)).toBe(true);
  });

  it("catches the wording the 2026-08-13 grep missed", () => {
    // The first attempt matched "cannot send"/"scope.*send" and walked past this one.
    const s = "The read tier asks for gmail.readonly and the manage tier for gmail.modify; neither grants a send capability.";
    expect(SCOPE_ANCHOR.test(s)).toBe(true);
    expect(NO_SEND.test(s)).toBe(true);
  });

  it("catches German wordings too — the other half the first attempt missed", () => {
    const s = "Die angeforderten Scopes können nicht senden.";
    expect(SCOPE_ANCHOR.test(s)).toBe(true);
    expect(NO_SEND.test(s)).toBe(true);
  });

  it("ignores a sentence about sending that names no scope", () => {
    const s = "There is no compose, reply, forward or send tool at all.";
    expect(SCOPE_ANCHOR.test(s)).toBe(false);
    expect(findScopeAnchoredClaims(s)).toHaveLength(0);
  });

  it("ignores a sentence about scopes that denies nothing", () => {
    const s = "The manage tier requests gmail.modify at authorization time.";
    expect(NO_SEND.test(s)).toBe(false);
    expect(findScopeAnchoredClaims(s)).toHaveLength(0);
  });

  it("flags an unqualified claim and clears a tier-qualified one", () => {
    expect(TIER_QUALIFIED.test("gmail.modify cannot send.")).toBe(false);
    expect(
      TIER_QUALIFIED.test(
        "On read Google enforces it at the token; on manage the promise rests on the tool surface, since gmail.modify does accept messages.send.",
      ),
    ).toBe(true);
  });

  it("splits table rows apart, so a claim in a cell cannot hide behind a neighbour", () => {
    const table = "| Capability | note |\n| gmail.modify cannot send | — |\n| unrelated | — |";
    const claims = findScopeAnchoredClaims(table);
    expect(claims).toHaveLength(1);
    expect(claims[0].sentence).toContain("gmail.modify cannot send");
  });
});

describe("send-claims: the allow list", () => {
  it("matches on a verbatim excerpt, so rewording a promise breaks the test", () => {
    const entry = ALLOWED[0];
    expect(isAllowed(entry.file, `prefix ${entry.excerpt} suffix`)).toBe(true);
    expect(isAllowed(entry.file, entry.excerpt.replace(/send/i, "transmit"))).toBe(false);
  });

  it("is scoped per file — the same sentence elsewhere is still unknown", () => {
    const entry = ALLOWED[0];
    expect(isAllowed("some/other/file.ts", entry.excerpt)).toBe(false);
  });

  it("every entry carries a reason", () => {
    for (const a of ALLOWED) {
      expect(a.file, JSON.stringify(a)).toBeTruthy();
      expect(a.excerpt, JSON.stringify(a)).toBeTruthy();
      expect(a.why?.length, `missing reason for ${a.file}: ${a.excerpt}`).toBeGreaterThan(30);
    }
  });

  it("keeps a local-only file's entries when a clone has no copy of it", () => {
    // CLAUDE.md is untracked (2026-09-04), so CI scans a corpus without it. If that counted as
    // "matches nothing any more", the first CI run would call two checked sentences dead and the
    // next reader would drop them — losing the check for the file where the rule actually lives.
    const local = ALLOWED.find((a: { file: string }) => LOCAL_ONLY.has(a.file));
    expect(local, "expected at least one allow-list entry for a local-only file").toBeTruthy();
    expect(staleAllowances({ "README.md": "" })).not.toContainEqual(local);
  });

  it("still reports a tracked file's entry as dead when its text no longer matches", () => {
    const tracked = ALLOWED.find((a: { file: string }) => !LOCAL_ONLY.has(a.file));
    expect(staleAllowances({ "README.md": "" })).toContainEqual(tracked);
  });

  it("reports an unknown claim rather than passing it", () => {
    const found = unknownClaims({ "fake.md": "The gmail.modify scope cannot send anything." });
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("fake.md");
  });
});

describe("send-claims: this repository", () => {
  it("scans the files that can carry the promise, including ones added later", () => {
    const files = Object.keys(scannedFiles());
    // The 2026-08-13 incident had the claim in six files at once, docs/SETUP.md among them.
    expect(files).toContain("README.md");
    expect(files).toContain("SECURITY.md");
    expect(files).toContain("docs/SETUP.md");
    expect(files).toContain("src/unsubscribe.ts");
    expect(files.some((f) => f.startsWith("src/"))).toBe(true);
  });

  it("has no scope-anchored no-send claim that nobody has checked", () => {
    const unknown = unknownClaims(scannedFiles());
    const report = unknown
      .map((u: { file: string; sentence: string; qualified: boolean }) =>
        `\n  ${u.file}${u.qualified ? "" : "   [no tier distinction in this sentence]"}\n    ${u.sentence.slice(0, 220)}`,
      )
      .join("\n");
    expect(
      unknown,
      unknown.length === 0
        ? ""
        : "New sentence(s) tying the no-send promise to an OAuth scope:\n" +
            report +
            "\n\nGoogle enforces no-send ONLY for gmail.readonly — it accepts gmail.modify on " +
            "messages.send. If the sentence claims the scopes cannot send, it is wrong: ground it " +
            "in the tool surface and the egress guard instead. If it is fine, add it to ALLOWED in " +
            "scripts/lib/send-claims.mjs with a reason.",
    ).toEqual([]);
  });

  it("has no dead allow-list entries", () => {
    const stale = staleAllowances(scannedFiles());
    expect(
      stale,
      stale.length === 0
        ? ""
        : "Allow-list entries matching nothing any more — the text changed, so the promise needs " +
            "re-reading before the line is updated or dropped:\n" +
            stale.map((a: { file: string; excerpt: string }) => `  ${a.file}: ${a.excerpt}`).join("\n"),
    ).toEqual([]);
  });
});
