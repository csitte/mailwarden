import { describe, it, expect } from "vitest";
import { asksForTrashOrSpam, matchesQuery, type QueryContext, type Searchable } from "../src/demo-query.js";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 86_400_000;

const ctx: QueryContext = {
  now: NOW,
  self: "you@example.com",
  labelIdsNamed: (name) => {
    const names: Record<string, string> = { "projects-kitchen": "Label_4", receipts: "Label_2", inbox: "INBOX", unread: "UNREAD" };
    const id = names[name.toLowerCase().replace(/[\s/_-]+/g, "-")];
    return id ? [id] : [];
  },
  isUserLabel: (id) => id.startsWith("Label_"),
};

const base: Searchable = {
  labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES", "Label_2"],
  from: "Ledgerline Bank <statements@ledgerline.example>",
  to: "Alex Morgan <you@example.com>",
  cc: "",
  bcc: "",
  subject: "Your October statement is ready",
  listId: "",
  messageId: "<t04-statement-m1@mail.example>",
  text: "Your statement for October is attached.",
  filenames: ["statement-2026-10.csv"],
  date: NOW - 4 * DAY,
  size: 2048,
};

const m = (over: Partial<Searchable> = {}): Searchable => ({ ...base, ...over });

describe("matchesQuery", () => {
  it.each([
    ["", true],
    ["statement", true],
    ["Statement", true],
    ['"october statement"', true],
    ['"statement october"', false],
    ["from:ledgerline.example", true],
    ["from:me", false],
    ["to:me", true],
    ["to:you@example.com", true],
    ["subject:october", true],
    ["subject:november", false],
    ["label:receipts", true],
    ["label:Receipts", true],
    ["label:projects/kitchen", false],
    ["in:inbox", true],
    ["-in:inbox", false],
    ["in:sent", false],
    ["in:anywhere", true],
    ["is:unread", true],
    ["is:read", false],
    ["is:starred", false],
    ["is:unstarred", true],
    ["has:attachment", true],
    ["has:userlabels", true],
    ["has:nouserlabels", false],
    ["category:updates", true],
    ["category:promotions", false],
    ["filename:csv", true],
    ["filename:pdf", false],
    ["newer_than:7d", true],
    ["newer_than:3d", false],
    ["older_than:3d", true],
    ["older_than:1m", false],
    ["after:2026/11/20", true],
    ["before:2026/11/20", false],
    ["after:2026-11-22", false],
    ["larger:1k", true],
    ["smaller:1k", false],
    ["rfc822msgid:t04-statement", true],
    ["from:ledgerline.example is:unread", true],
    ["from:ledgerline.example is:read", false],
    ["is:read OR has:attachment", true],
    ["is:read OR is:starred", false],
    ["{is:read has:attachment}", true],
    ["{is:read is:starred}", false],
    ["-(is:read OR is:starred)", true],
    ["(from:nobody.example OR subject:october) category:updates", true],
    ["unknownop:x", false],
  ])("%s → %s", (q, want) => {
    expect(matchesQuery(q, m(), ctx)).toBe(want);
  });

  it("reads an unknown operator as a free word, the way Gmail does", () => {
    expect(matchesQuery("ticket:42", m({ text: "see ticket:42 for details" }), ctx)).toBe(true);
  });

  it("survives broken syntax without throwing", () => {
    for (const q of ["(", ")", "{", "}", '"', "-", "OR", "from:", "((is:unread", "is:unread)", "- -", "{OR}"]) {
      expect(() => matchesQuery(q, m(), ctx), q).not.toThrow();
    }
    expect(matchesQuery("((is:unread", m(), ctx)).toBe(true);
    expect(matchesQuery("is:unread)", m(), ctx)).toBe(true);
  });

  it("takes a quoted operator value", () => {
    expect(matchesQuery('subject:"October statement"', m(), ctx)).toBe(true);
    expect(matchesQuery('subject:"statement October"', m(), ctx)).toBe(false);
  });
});

describe("asksForTrashOrSpam", () => {
  it.each([
    ["in:trash", true],
    ["in:spam from:x", true],
    ["(in:trash OR in:inbox)", true],
    ["in:anywhere", true],
    ["label:spam", true],
    ["-in:trash", false],
    ["from:trash.example", false],
    ["subject:spam", false],
    ["", false],
  ])("%s → %s", (q, want) => {
    expect(asksForTrashOrSpam(q)).toBe(want);
  });
});
