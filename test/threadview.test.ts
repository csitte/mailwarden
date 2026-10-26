import { describe, expect, it } from "vitest";
import { checkThreadOptions, selectMessages, trimBodies } from "../src/threadview.js";
import type { ParsedMessage } from "../src/gmail.js";
import { ToolError } from "../src/cli.js";

const ids = (...xs: string[]) => xs.map((id) => ({ id }));

describe("checkThreadOptions", () => {
  it("accepts every combination that can be honoured", () => {
    for (const o of [
      {},
      { full: true },
      { full: false },
      { bodies: "text" as const },
      { full: true, bodies: "none" as const },
      { full: true, bodies: "full" as const },
    ]) {
      expect(() => checkThreadOptions(o), JSON.stringify(o)).not.toThrow();
    }
  });

  it("rejects full:false with ANY bodies value, naming both ways out", () => {
    for (const bodies of ["full", "text", "none"] as const) {
      let err: unknown;
      try {
        checkThreadOptions({ full: false, bodies });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("invalid_input");
      expect((err as ToolError).message).toContain(`bodies: "${bodies}"`);
      expect((err as ToolError).message).toMatch(/Drop full: false .* or drop bodies/);
    }
  });
});

function msg(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    from: "a@example.com",
    to: "b@example.com",
    subject: "s",
    date: "Mon, 01 Jun 2026 10:00:00 +0000",
    snippet: "snip",
    authentication: { unchecked: true } as ParsedMessage["authentication"],
    plaintextBody: "plain",
    htmlBody: "<p>html</p>",
    attachments: [{ messageId: "m1", attachmentId: "a1", filename: "r.pdf", mimeType: "application/pdf", size: 3 }],
    ...over,
  };
}

describe("selectMessages", () => {
  it("returns everything and counts nothing omitted when nothing is asked", () => {
    expect(selectMessages(ids("a", "b", "c"), {})).toEqual({ messages: ids("a", "b", "c"), omitted: 0 });
  });

  it("lastN keeps the newest N — thread order is oldest first", () => {
    expect(selectMessages(ids("a", "b", "c"), { lastN: 2 })).toEqual({ messages: ids("b", "c"), omitted: 1 });
  });

  it("lastN larger than the thread is not an error and omits nothing", () => {
    expect(selectMessages(ids("a", "b"), { lastN: 5 })).toEqual({ messages: ids("a", "b"), omitted: 0 });
  });

  it("afterMessageId drops the named message and everything before it", () => {
    expect(selectMessages(ids("a", "b", "c", "d"), { afterMessageId: "b" })).toEqual({
      messages: ids("c", "d"),
      omitted: 2,
    });
  });

  it("afterMessageId on the newest message yields an empty list, not an error — that is 'no news'", () => {
    expect(selectMessages(ids("a", "b"), { afterMessageId: "b" })).toEqual({ messages: [], omitted: 2 });
  });

  it("afterMessageId then lastN: 'the last one since X' composes", () => {
    expect(selectMessages(ids("a", "b", "c", "d"), { afterMessageId: "a", lastN: 1 })).toEqual({
      messages: ids("d"),
      omitted: 3,
    });
  });

  it("an afterMessageId the thread does not contain is invalid_input and names the ids it has", () => {
    let err: unknown;
    try {
      selectMessages(ids("a", "b"), { afterMessageId: "zz" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("invalid_input");
    expect((err as ToolError).message).toContain("zz");
    expect((err as ToolError).message).toContain("a, b");
  });

  it("an empty thread with lastN stays empty", () => {
    expect(selectMessages([], { lastN: 3 })).toEqual({ messages: [], omitted: 0 });
  });
});

describe("trimBodies", () => {
  it("full returns the very same object — the default costs nothing", () => {
    const m = msg();
    expect(trimBodies(m, "full")).toBe(m);
  });

  it("none drops both bodies and keeps headers, authentication and attachments", () => {
    const out = trimBodies(msg(), "none") as Record<string, unknown>;
    expect("plaintextBody" in out).toBe(false);
    expect("htmlBody" in out).toBe(false);
    expect(out).toMatchObject({ id: "m1", subject: "s", attachments: [{ filename: "r.pdf" }] });
    expect(out.authentication).toEqual({ unchecked: true });
  });

  it("text keeps the plaintext part when there is one and drops the HTML", () => {
    const out = trimBodies(msg(), "text") as Record<string, unknown>;
    expect(out.plaintextBody).toBe("plain");
    expect("htmlBody" in out).toBe(false);
    expect("bodyFromHtml" in out).toBe(false);
  });

  it("text reduces an HTML-only mail to text and says so", () => {
    const out = trimBodies(msg({ plaintextBody: "", htmlBody: "<p>Hello&nbsp;<b>world</b></p><p>bye</p>" }), "text");
    expect(out.plaintextBody).toBe("Hello world\nbye");
    expect(out.bodyFromHtml).toBe(true);
  });

  it("text treats a whitespace-only plaintext part as absent", () => {
    const out = trimBodies(msg({ plaintextBody: " \n ", htmlBody: "<div>real</div>" }), "text");
    expect(out.plaintextBody).toBe("real");
    expect(out.bodyFromHtml).toBe(true);
  });

  it("text on a mail with no body at all keeps an empty plaintextBody and no bodyFromHtml flag", () => {
    const out = trimBodies(msg({ plaintextBody: "", htmlBody: "<style>p{}</style>" }), "text") as Record<string, unknown>;
    expect(out.plaintextBody).toBe("");
    expect("bodyFromHtml" in out).toBe(false);
    expect("htmlBody" in out).toBe(false);
  });

  it("never mutates its input", () => {
    const m = msg();
    const before = JSON.stringify(m);
    trimBodies(m, "text");
    trimBodies(m, "none");
    expect(JSON.stringify(m)).toBe(before);
  });
});
