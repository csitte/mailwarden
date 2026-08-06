import { describe, it, expect } from "vitest";
import {
  parseSender,
  ageBucket,
  friendlyLabelName,
  buildDigest,
} from "../src/digest.js";
import type { ThreadSummary } from "../src/gmail.js";

/** Minimal ThreadSummary builder — only the fields buildDigest reads matter. */
function thread(p: Partial<ThreadSummary>): ThreadSummary {
  return {
    threadId: "t",
    messageCount: 1,
    from: "",
    subject: "",
    date: "",
    labelIds: [],
    snippet: "",
    hasAttachments: false,
    ...p,
  };
}

describe("parseSender", () => {
  it("splits a name + angle-addr, lowercasing the address", () => {
    expect(parseSender("Alice Example <Alice@Example.COM>")).toEqual({
      email: "alice@example.com",
      name: "Alice Example",
    });
  });
  it("handles a bare address and strips a quoted display name", () => {
    expect(parseSender("bob@y.com")).toEqual({ email: "bob@y.com", name: "" });
    expect(parseSender('"Doe, Jane" <jane@x.com>')).toEqual({ email: "jane@x.com", name: "Doe, Jane" });
  });
});

describe("ageBucket", () => {
  const now = new Date("2026-06-20T12:00:00Z");
  it("buckets by age relative to now", () => {
    expect(ageBucket("2026-06-20T06:00:00Z", now)).toBe("last24h"); // 6h ago
    expect(ageBucket("2026-06-17T12:00:00Z", now)).toBe("last7d"); // 3d ago
    expect(ageBucket("2026-06-01T12:00:00Z", now)).toBe("last30d"); // 19d ago
    expect(ageBucket("2026-01-01T12:00:00Z", now)).toBe("older"); // ~half a year
  });
  it("returns 'undated' for an unparseable header", () => {
    expect(ageBucket("", now)).toBe("undated");
    expect(ageBucket("not a date", now)).toBe("undated");
  });
});

describe("friendlyLabelName", () => {
  const names = new Map([["Label_7", "Work"]]);
  it("maps known system/category ids to friendly names", () => {
    expect(friendlyLabelName("CATEGORY_PROMOTIONS", names)).toBe("Promotions");
    expect(friendlyLabelName("IMPORTANT", names)).toBe("Important");
  });
  it("falls back to the user label name, then the raw id", () => {
    expect(friendlyLabelName("Label_7", names)).toBe("Work");
    expect(friendlyLabelName("Label_unknown", names)).toBe("Label_unknown");
  });
});

describe("buildDigest", () => {
  const now = new Date("2026-06-20T12:00:00Z");
  const id = (x: string) => x; // identity label resolver

  it("counts unread, attachments, and age buckets", () => {
    const d = buildDigest(
      [
        thread({ from: "a@x.com", labelIds: ["INBOX", "UNREAD"], date: "2026-06-20T06:00:00Z" }),
        thread({ from: "b@x.com", labelIds: ["INBOX"], date: "2026-06-10T12:00:00Z", hasAttachments: true }),
        thread({ from: "c@x.com", labelIds: ["INBOX", "UNREAD"], date: "bad-date" }),
      ],
      id,
      now,
    );
    expect(d.sampled).toBe(3);
    expect(d.unread).toBe(2);
    expect(d.withAttachments).toBe(1);
    expect(d.byAge).toEqual({ last24h: 1, last7d: 0, last30d: 1, older: 0, undated: 1 });
  });

  it("ranks senders by count with per-sender unread, keeping a display name", () => {
    const d = buildDigest(
      [
        thread({ from: "News <news@x.com>", labelIds: ["INBOX", "UNREAD"] }),
        thread({ from: "news@x.com", labelIds: ["INBOX"] }), // same address, no name
        thread({ from: "solo@y.com", labelIds: ["INBOX", "UNREAD"] }),
      ],
      id,
      now,
      { topN: 10 },
    );
    expect(d.topSenders).toEqual([
      { sender: "news@x.com", name: "News", count: 2, unread: 1 },
      { sender: "solo@y.com", name: "", count: 1, unread: 1 },
    ]);
  });

  it("counts labels via the resolver, skipping inbox/read-state noise", () => {
    const d = buildDigest(
      [
        thread({ from: "a@x.com", labelIds: ["INBOX", "UNREAD", "Label_7"] }),
        thread({ from: "b@x.com", labelIds: ["INBOX", "Label_7", "CATEGORY_PROMOTIONS"] }),
      ],
      (x) => friendlyLabelName(x, new Map([["Label_7", "Work"]])),
      now,
    );
    // INBOX + UNREAD are skipped; Work (2) outranks Promotions (1).
    expect(d.topLabels).toEqual([
      { label: "Work", count: 2 },
      { label: "Promotions", count: 1 },
    ]);
  });

  it("merges labels that resolve to the same display name", () => {
    const d = buildDigest(
      [
        thread({ from: "a@x.com", labelIds: ["INBOX", "IMPORTANT"] }), // system → "Important"
        thread({ from: "b@x.com", labelIds: ["INBOX", "Label_x"] }), // user label also named "Important"
      ],
      (x) => (x === "Label_x" ? "Important" : friendlyLabelName(x, new Map())),
      now,
    );
    expect(d.topLabels).toEqual([{ label: "Important", count: 2 }]); // one row, not two
  });

  it("honors topN and groups empty From under (unknown)", () => {
    const d = buildDigest(
      [
        thread({ from: "a@x.com", labelIds: ["INBOX"] }),
        thread({ from: "b@x.com", labelIds: ["INBOX"] }),
        thread({ from: "", labelIds: ["INBOX"] }),
      ],
      id,
      now,
      { topN: 1 },
    );
    expect(d.topSenders).toHaveLength(1); // capped by topN
    const senders = buildDigest(
      [thread({ from: "", labelIds: ["INBOX"] })],
      id,
      now,
    ).topSenders;
    expect(senders[0].sender).toBe("(unknown)");
  });
});
