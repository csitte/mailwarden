import { describe, it, expect, vi, afterEach } from "vitest";
import type { gmail_v1 } from "googleapis";
import { parseSender } from "../src/digest.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectAttachments,
  collectBodies,
  isRealAttachment,
  referencedCids,
  looksLikeLabelId,
  deriveLabelFilters,
  unverifiedPredicates,
  threadMatchesFilters,
  labelChangeApplied,
  classifyBatchModify,
  parseMessage,
  decodeRfc2047,
  decodeAddressHeader,
  withBackoff,
  isInvalidGrant,
  isInsufficientScope,
  filterCriteriaToApi,
  filterCriteriaFromApi,
  filterCriteriaToQuery,
  Gmail,
  PARSED_HEADERS,
} from "../src/gmail.js";

// node Buffer base64url helper for building test fixtures
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("collectAttachments — Bug 1: inline images must not count", () => {
  const inlineLogo: gmail_v1.Schema$MessagePart = {
    filename: "logo.png",
    mimeType: "image/png",
    headers: [
      { name: "Content-Disposition", value: "inline; filename=logo.png" },
      { name: "Content-ID", value: "<logo123>" },
    ],
    body: { attachmentId: "att-inline", size: 1234 },
  };

  const realPdf: gmail_v1.Schema$MessagePart = {
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    headers: [{ name: "Content-Disposition", value: "attachment; filename=invoice.pdf" }],
    body: { attachmentId: "att-pdf", size: 9999 },
  };

  const message: gmail_v1.Schema$Message = {
    id: "msg-1",
    threadId: "th-1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/html", body: { data: b64url("<p>hi</p>") } }, inlineLogo, realPdf],
    },
  };

  it("excludes the inline image", () => {
    expect(isRealAttachment(inlineLogo)).toBe(false);
  });

  it("includes the real PDF attachment", () => {
    expect(isRealAttachment(realPdf)).toBe(true);
  });

  it("collects only the real attachment from the full message", () => {
    const atts = collectAttachments(message);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      messageId: "msg-1",
      attachmentId: "att-pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 9999,
    });
  });

  it("treats an attachment with no Content-Disposition header as real", () => {
    const noDisposition: gmail_v1.Schema$MessagePart = {
      filename: "scan.pdf",
      mimeType: "application/pdf",
      body: { attachmentId: "att-nd", size: 5 },
    };
    expect(isRealAttachment(noDisposition)).toBe(true);
  });
});

describe("collectAttachments — Bug 6: attachment with unreferenced Content-ID, no disposition (maut1 invoices)", () => {
  // Real maut1 shape: multipart/mixed with the HTML, a PDF carrying a Content-ID
  // but NO Content-Disposition (and whose cid is never referenced in the HTML),
  // and inline images whose cids ARE referenced. The PDF was wrongly dropped.
  const html =
    '<p>Rechnung</p><img src="cid:logo-da4b845d"><img src="cid:fb-1db1fee0">';

  const invoicePdf: gmail_v1.Schema$MessagePart = {
    filename: "Rechnung VR02056331.pdf",
    mimeType: "application/pdf",
    headers: [{ name: "Content-ID", value: "<pdf-4b301948>" }], // present but NOT referenced
    body: { attachmentId: "att-pdf", size: 55244 },
  };
  const inlineLogo: gmail_v1.Schema$MessagePart = {
    filename: "image.jpeg",
    mimeType: "image/jpeg",
    headers: [{ name: "Content-ID", value: "<logo-da4b845d>" }], // referenced in html
    body: { attachmentId: "att-logo", size: 2896 },
  };
  const inlineFb: gmail_v1.Schema$MessagePart = {
    filename: "faceb.png",
    mimeType: "image/png",
    headers: [{ name: "Content-ID", value: "<fb-1db1fee0>" }], // referenced in html
    body: { attachmentId: "att-fb", size: 1059 },
  };

  const message: gmail_v1.Schema$Message = {
    id: "msg-maut1",
    threadId: "th-maut1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/html", body: { data: b64url(html) } }, invoicePdf, inlineLogo, inlineFb],
    },
  };

  it("referencedCids extracts only the cids used via cid: in the body", () => {
    expect(referencedCids(html)).toEqual(new Set(["logo-da4b845d", "fb-1db1fee0"]));
  });

  it("treats a PDF with an UNreferenced Content-ID + no disposition as a real attachment", () => {
    expect(isRealAttachment(invoicePdf, referencedCids(html))).toBe(true);
  });

  it("excludes images whose Content-ID IS referenced in the body", () => {
    const refs = referencedCids(html);
    expect(isRealAttachment(inlineLogo, refs)).toBe(false);
    expect(isRealAttachment(inlineFb, refs)).toBe(false);
  });

  it("collects exactly the invoice PDF (not the inline images)", () => {
    const atts = collectAttachments(message);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      attachmentId: "att-pdf",
      filename: "Rechnung VR02056331.pdf",
      mimeType: "application/pdf",
      size: 55244,
    });
  });

  it("marks the thread as having attachments", () => {
    expect(collectAttachments(message).length > 0).toBe(true);
  });
});

describe("collectBodies — Bug 4: base64url decode", () => {
  it("decodes text/plain and text/html from base64url", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain body") } },
        { mimeType: "text/html", body: { data: b64url("<b>html body</b>") } },
      ],
    };
    const { text, html } = collectBodies(payload);
    expect(text).toBe("plain body");
    expect(html).toBe("<b>html body</b>");
  });

  it("decodes content whose base64url contains '-' or '_' (would corrupt under plain base64)", () => {
    // Pick a string whose standard base64 contains '+' or '/', so its base64url
    // form contains '-' or '_'. "subjects??" -> base64 "c3ViamVjdHM/Pw==" (has '/'),
    // base64url "c3ViamVjdHM_Pw". If decoded as plain base64, '_' is invalid.
    const original = "subjects??";
    const encoded = Buffer.from(original, "utf8").toString("base64url");
    expect(encoded).toMatch(/[-_]/); // sanity: fixture actually exercises the url alphabet

    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: encoded },
    };
    expect(collectBodies(payload).text).toBe(original);
  });

  it("decodes a non-UTF-8 part via its Content-Type charset (no mojibake)", () => {
    const original = "Grüße für März";
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
      body: { data: Buffer.from(original, "latin1").toString("base64url") },
    };
    expect(collectBodies(payload).text).toBe(original);
  });

  it("falls back to UTF-8 for an unknown charset label", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-no-such-charset" }],
      body: { data: b64url("plain body") },
    };
    expect(collectBodies(payload).text).toBe("plain body");
  });
});

describe("looksLikeLabelId", () => {
  it("recognises system label ids and Label_* / CATEGORY_* as ids", () => {
    for (const id of ["INBOX", "UNREAD", "TRASH", "CATEGORY_PROMOTIONS", "Label_21"]) {
      expect(looksLikeLabelId(id)).toBe(true);
    }
  });
  it("treats human-readable names as non-ids", () => {
    for (const name of ["ToDo", "MCP/Snoozed", "Scanbot/zu-löschen"]) {
      expect(looksLikeLabelId(name)).toBe(false);
    }
  });
});

describe("deriveLabelFilters — Bug 5: re-verify is:unread & co against live labels", () => {
  it("maps read-state and category operators (with negation) to label predicates", () => {
    expect(deriveLabelFilters("is:unread")).toEqual([{ labelId: "UNREAD", present: true }]);
    expect(deriveLabelFilters("-is:unread")).toEqual([{ labelId: "UNREAD", present: false }]);
    expect(deriveLabelFilters("is:read")).toEqual([{ labelId: "UNREAD", present: false }]);
    expect(deriveLabelFilters("is:starred")).toEqual([{ labelId: "STARRED", present: true }]);
    expect(deriveLabelFilters("is:unstarred")).toEqual([{ labelId: "STARRED", present: false }]);
    expect(deriveLabelFilters("-in:inbox")).toEqual([{ labelId: "INBOX", present: false }]);
    expect(deriveLabelFilters("category:updates")).toEqual([
      { labelId: "CATEGORY_UPDATES", present: true },
    ]);
    expect(deriveLabelFilters("category:primary")).toEqual([
      { labelId: "CATEGORY_PERSONAL", present: true },
    ]);
  });

  it("collects every recognised token from a compound query, ignoring the rest", () => {
    // the exact failing real-world query — plus free-text/date operators we don't map
    expect(deriveLabelFilters("category:updates is:unread -in:inbox newer_than:30d invoice")).toEqual([
      { labelId: "CATEGORY_UPDATES", present: true },
      { labelId: "UNREAD", present: true },
      { labelId: "INBOX", present: false },
    ]);
  });

  it("is case-insensitive on the operator", () => {
    expect(deriveLabelFilters("IS:UNREAD")).toEqual([{ labelId: "UNREAD", present: true }]);
  });

  it("returns no filter for queries with no mappable predicate", () => {
    expect(deriveLabelFilters("from:foo@bar.com newer_than:7d")).toEqual([]);
    expect(deriveLabelFilters("label:ToDo")).toEqual([]); // user-label names are not resolved here
  });

  it("disables filtering for boolean-grouped queries to respect the user's logic", () => {
    expect(deriveLabelFilters("is:unread OR is:starred")).toEqual([]);
    expect(deriveLabelFilters("{is:unread is:starred}")).toEqual([]);
    expect(deriveLabelFilters("(is:unread from:x)")).toEqual([]);
  });

  it("disables filtering for quoted queries (a literal is:unread inside a phrase is not a predicate)", () => {
    expect(deriveLabelFilters('subject:"bitte is:unread prüfen"')).toEqual([]);
    expect(deriveLabelFilters('"exact phrase" is:unread')).toEqual([]);
  });
});

describe("labelChangeApplied / classifyBatchModify", () => {
  it("counts a message as applied only when every add is present and every remove is gone", () => {
    expect(labelChangeApplied(["A", "B"], ["A"], [])).toBe(true);
    expect(labelChangeApplied(["A", "B"], ["A", "B"], [])).toBe(true);
    expect(labelChangeApplied(["A"], ["A", "B"], [])).toBe(false); // one add missing
    expect(labelChangeApplied(["A", "INBOX"], ["A"], ["INBOX"])).toBe(false); // remove still there
    expect(labelChangeApplied(["A"], ["A"], ["INBOX"])).toBe(true);
    expect(labelChangeApplied([], [], ["INBOX"])).toBe(true);
  });

  it("treats an already-correct message as applied (end state, not diff)", () => {
    // batchModify is idempotent, so 'was already labelled' and 'we labelled it' are
    // indistinguishable afterwards — claiming otherwise would need a before-state we
    // deliberately do not keep (no cache).
    expect(labelChangeApplied(["Label_todo"], ["Label_todo"], [])).toBe(true);
  });

  it("splits submitted ids into applied / notApplied / unverifiable", () => {
    const endState = new Map<string, string[]>([
      ["m1", ["Label_todo"]],
      ["m2", ["INBOX"]],
    ]);
    expect(classifyBatchModify(["m1", "m2", "m3"], endState, ["Label_todo"], ["INBOX"])).toEqual({
      applied: 1,
      notApplied: ["m2"],
      unverifiable: ["m3"],
    });
  });

  it("an id absent from the end state is unverifiable, never notApplied", () => {
    // The difference decides what a caller does next: notApplied justifies a retry,
    // unverifiable justifies a second look. Collapsing them invents a fact.
    const res = classifyBatchModify(["gone"], new Map(), ["Label_x"], []);
    expect(res.unverifiable).toEqual(["gone"]);
    expect(res.notApplied).toEqual([]);
    expect(res.applied).toBe(0);
  });

  it("a message with no labels at all is notApplied, not unverifiable", () => {
    // Known end state that happens to be empty — that IS an observation.
    const res = classifyBatchModify(["m1"], new Map([["m1", []]]), ["Label_x"], []);
    expect(res.notApplied).toEqual(["m1"]);
    expect(res.unverifiable).toEqual([]);
  });

  it("reports nothing for an empty submission", () => {
    expect(classifyBatchModify([], new Map(), ["A"], ["B"])).toEqual({
      applied: 0,
      notApplied: [],
      unverifiable: [],
    });
  });
});

describe("threadMatchesFilters", () => {
  const filters = [
    { labelId: "UNREAD", present: true },
    { labelId: "INBOX", present: false },
  ];
  it("passes a thread satisfying every predicate", () => {
    expect(threadMatchesFilters(["UNREAD", "CATEGORY_UPDATES"], filters)).toBe(true);
  });
  it("rejects a read thread (missing required UNREAD)", () => {
    expect(threadMatchesFilters(["CATEGORY_UPDATES"], filters)).toBe(false);
  });
  it("rejects a thread carrying a forbidden label (INBOX present)", () => {
    expect(threadMatchesFilters(["UNREAD", "INBOX"], filters)).toBe(false);
  });
  it("an empty filter set matches anything (raw index passthrough)", () => {
    expect(threadMatchesFilters(["CATEGORY_PROMOTIONS"], [])).toBe(true);
  });
});

describe("Gmail.search — drops index false positives via live-label re-verify", () => {
  // Fake api whose threads.list index is LOOSE: it returns read mail for an
  // is:unread query (the real Gmail bug). threads.get returns the true labels.
  function fakeSearchApi(threads: Record<string, string[]>) {
    const ids = Object.keys(threads);
    let listMaxResults = 0;
    let getCount = 0;
    const api: any = {
      users: {
        threads: {
          list: async (req: any) => {
            listMaxResults = req.maxResults;
            return { data: { threads: ids.map((id) => ({ id, snippet: `snip-${id}` })) } };
          },
          get: async (req: any) => {
            getCount++;
            return {
              data: {
                messages: [
                  {
                    id: `m-${req.id}`,
                    labelIds: threads[req.id],
                    snippet: `snip-${req.id}`,
                    payload: { headers: [{ name: "Subject", value: `subj-${req.id}` }] },
                  },
                ],
              },
            };
          },
        },
      },
    };
    return { api, stats: () => ({ listMaxResults, getCount }) };
  }

  it("returns only genuinely-unread threads for an is:unread query", async () => {
    const { api } = fakeSearchApi({
      a: ["CATEGORY_UPDATES", "UNREAD"],
      b: ["CATEGORY_UPDATES"], // read → index false positive, must be dropped
      c: ["CATEGORY_UPDATES", "UNREAD"],
    });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("category:updates is:unread -in:inbox", 25);
    expect(res.threads.map((r) => r.threadId)).toEqual(["a", "c"]);
  });

  it("over-scans candidates (full page) when filtering so maxResults stays meaningful", async () => {
    const { api, stats } = fakeSearchApi({ a: ["UNREAD"] });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.search("is:unread", 25);
    expect(stats().listMaxResults).toBe(100); // FILTER_SCAN_CAP, not 25
  });

  it("stops fetching once maxResults genuine matches are found (early break, chunk granularity)", async () => {
    // gets run in parallel chunks of GET_CONCURRENCY (8) — the early break can
    // overshoot by at most one chunk, so 3 candidates are all fetched at once,
    // but only the first 2 are returned. With 9+ candidates the second chunk
    // would be skipped.
    const { api, stats } = fakeSearchApi({
      a: ["UNREAD"],
      b: ["UNREAD"],
      c: ["UNREAD"],
    });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("is:unread", 2);
    expect(res.threads.map((r) => r.threadId)).toEqual(["a", "b"]);
    expect(stats().getCount).toBeLessThanOrEqual(8); // one chunk, not the full page
  });

  it("leaves an unfiltered query untouched (lists exactly maxResults)", async () => {
    const { api, stats } = fakeSearchApi({ a: ["INBOX"], b: ["INBOX"] });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.search("from:foo@bar.com", 25);
    expect(stats().listMaxResults).toBe(25); // no over-scan when nothing to verify
  });

  it("skips a candidate whose get fails (vanished between list and get) instead of failing the whole search", async () => {
    // Unfiltered query so every candidate is kept; the middle thread 404s (deleted
    // after the list snapshot). The search must still return a and c.
    const api: any = {
      users: {
        threads: {
          list: async () => ({
            data: { threads: [{ id: "a" }, { id: "b" }, { id: "c" }] },
          }),
          get: async (req: any) => {
            if (req.id === "b") throw Object.assign(new Error("not found"), { status: 404 });
            return {
              data: {
                messages: [
                  {
                    id: `m-${req.id}`,
                    labelIds: ["INBOX"],
                    payload: { headers: [{ name: "Subject", value: `subj-${req.id}` }] },
                  },
                ],
              },
            };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("from:foo@bar.com", 25);
    expect(res.threads.map((r) => r.threadId)).toEqual(["a", "c"]);
  });

  it("derives each summary's signals from the thread's FIRST message (its origin), not a later reply", async () => {
    const api: any = {
      users: {
        threads: {
          list: async () => ({ data: { threads: [{ id: "nl" }, { id: "plain" }] } }),
          get: async (req: any) => ({
            data: {
              messages:
                req.id === "nl"
                  ? [
                      {
                        id: "m1",
                        labelIds: ["INBOX"],
                        payload: {
                          headers: [
                            { name: "From", value: "News <news@x.example>" },
                            { name: "List-Unsubscribe", value: "<https://x.example/u>" },
                          ],
                        },
                      },
                      // The user's own reply carries no list headers — the thread stays a newsletter.
                      { id: "m2", labelIds: ["SENT"], payload: { headers: [{ name: "From", value: "me@x.example" }] } },
                    ]
                  : [{ id: "m3", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "a@y.example" }] } }],
            },
          }),
        },
      },
    };
    const res = await new Gmail(api as gmail_v1.Gmail).search("in:inbox", 25);
    expect(res.threads.map((r) => [r.threadId, r.signals])).toEqual([
      ["nl", ["newsletter"]],
      ["plain", []],
    ]);
  });
});

describe("modifyLabels — Bug 3: name → id resolution", () => {
  // Minimal fake gmail_v1.Gmail capturing the modify request body.
  function fakeApi() {
    const calls: { modify: any[]; create: any[] } = { modify: [], create: [] };
    const api: any = {
      users: {
        labels: {
          list: async () => ({
            data: {
              labels: [
                { id: "Label_21", name: "ToDo", type: "user" },
                { id: "Label_7", name: "Scanbot/abgelegt", type: "user" },
              ],
            },
          }),
          create: async (req: any) => {
            calls.create.push(req);
            return { data: { id: "Label_NEW" } };
          },
        },
        threads: {
          modify: async (req: any) => {
            calls.modify.push(req);
            return { data: {} };
          },
        },
      },
    };
    return { api, calls };
  }

  it("translates a known name to its id and passes ids through unchanged", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["ToDo"], ["INBOX"]);

    expect(calls.modify).toHaveLength(1);
    const body = calls.modify[0].requestBody;
    expect(body.addLabelIds).toEqual(["Label_21"]); // name → id
    expect(body.removeLabelIds).toEqual(["INBOX"]); // id passes through
    expect(calls.create).toHaveLength(0); // existing name → no create
  });

  it("creates an unknown name in `add` via ensureLabel", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["BrandNew"], []);

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].requestBody.name).toBe("BrandNew");
    expect(calls.modify[0].requestBody.addLabelIds).toEqual(["Label_NEW"]);
  });

  it("skips an unknown name in `remove`", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", [], ["DoesNotExist"]);

    expect(calls.modify[0].requestBody.removeLabelIds).toEqual([]);
    expect(calls.create).toHaveLength(0);
  });

  it("resolves names case-insensitively (Gmail label names are unique case-insensitively)", async () => {
    const { api, calls } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["todo"], ["SCANBOT/ABGELEGT"]);

    expect(calls.modify[0].requestBody.addLabelIds).toEqual(["Label_21"]);
    expect(calls.modify[0].requestBody.removeLabelIds).toEqual(["Label_7"]);
    expect(calls.create).toHaveLength(0); // no bogus create that the API would reject as a conflict
  });

  it("skips listLabels() when only ids are passed (no name lookup needed)", async () => {
    const { api } = fakeApi();
    let listCalled = false;
    api.users.labels.list = async () => {
      listCalled = true;
      return { data: { labels: [] } };
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.modifyLabels("th-1", ["INBOX"], ["UNREAD"]);
    expect(listCalled).toBe(false);
  });
});

describe("referencedCids — edge cases", () => {
  it("merges cids from multiple bodies and stops at delimiters", () => {
    expect(referencedCids('<img src="cid:a"> tail', "see (cid:b) and cid:c]")).toEqual(
      new Set(["a", "b", "c"]),
    );
  });

  it("matches the cid: prefix case-insensitively and lowercases the id", () => {
    expect(referencedCids("CID:Upper")).toEqual(new Set(["upper"]));
  });

  it("returns an empty set for bodies without references", () => {
    expect(referencedCids("", "no references here")).toEqual(new Set());
  });
});

describe("isRealAttachment — precedence & preconditions", () => {
  it("explicit Content-Disposition: attachment wins even over a referenced Content-ID", () => {
    const p: gmail_v1.Schema$MessagePart = {
      filename: "f.pdf",
      headers: [
        { name: "Content-Disposition", value: "attachment; filename=f.pdf" },
        { name: "Content-ID", value: "<x>" },
      ],
      body: { attachmentId: "a", size: 1 },
    };
    expect(isRealAttachment(p, new Set(["x"]))).toBe(true);
  });

  it("matches Content-ID against referenced cids case-insensitively", () => {
    const p: gmail_v1.Schema$MessagePart = {
      filename: "logo.png",
      headers: [{ name: "Content-ID", value: "<Logo1>" }],
      body: { attachmentId: "a", size: 1 },
    };
    expect(isRealAttachment(p, referencedCids('<img src="cid:logo1">'))).toBe(false);
  });

  it("requires a filename and an attachmentId", () => {
    expect(isRealAttachment({ filename: "", body: { attachmentId: "a" } })).toBe(false);
    expect(isRealAttachment({ filename: "f.pdf", body: {} })).toBe(false);
    expect(isRealAttachment({ filename: "f.pdf" })).toBe(false);
  });
});

describe("collectBodies — nested multiparts", () => {
  it("concatenates text parts across nesting levels", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("first ") } },
            { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
          ],
        },
        { mimeType: "text/plain", body: { data: b64url("second") } },
      ],
    };
    const { text, html } = collectBodies(payload);
    expect(text).toBe("first second");
    expect(html).toBe("<p>html</p>");
  });
});

describe("parseMessage — full integration", () => {
  const message: gmail_v1.Schema$Message = {
    id: "msg-9",
    threadId: "th-9",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "snippet text",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "bob@example.com" },
        { name: "subject", value: "Hello" }, // lowercase on purpose
        { name: "Date", value: "Sat, 18 Jul 2026 10:00:00 +0200" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url("body text") } },
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { attachmentId: "att-1", size: 42 },
        },
      ],
    },
  };

  it("maps headers (case-insensitively), bodies, labels, and attachments", () => {
    const parsed = parseMessage(message);
    expect(parsed).toMatchObject({
      id: "msg-9",
      threadId: "th-9",
      labelIds: ["INBOX", "UNREAD"],
      from: "Alice <alice@example.com>",
      to: "bob@example.com",
      subject: "Hello",
      date: "Sat, 18 Jul 2026 10:00:00 +0200",
      snippet: "snippet text",
      plaintextBody: "body text",
      htmlBody: "",
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ messageId: "msg-9", attachmentId: "att-1" });
  });

  it("defaults missing headers and bodies to empty strings", () => {
    const parsed = parseMessage({ id: "m", threadId: "t", payload: {} });
    expect(parsed).toMatchObject({ from: "", to: "", subject: "", date: "", plaintextBody: "", htmlBody: "" });
    expect(parsed.attachments).toEqual([]);
  });
});

describe("deriveLabelFilters — remaining operators", () => {
  it("maps importance and folder operators (with negation)", () => {
    expect(deriveLabelFilters("is:important")).toEqual([{ labelId: "IMPORTANT", present: true }]);
    expect(deriveLabelFilters("-is:important")).toEqual([{ labelId: "IMPORTANT", present: false }]);
    expect(deriveLabelFilters("is:unimportant")).toEqual([{ labelId: "IMPORTANT", present: false }]);
    expect(deriveLabelFilters("in:trash")).toEqual([{ labelId: "TRASH", present: true }]);
    expect(deriveLabelFilters("in:spam")).toEqual([{ labelId: "SPAM", present: true }]);
    expect(deriveLabelFilters("-in:trash")).toEqual([{ labelId: "TRASH", present: false }]);
  });

  it("maps negated categories and ignores unknown ones", () => {
    expect(deriveLabelFilters("-category:social")).toEqual([{ labelId: "CATEGORY_SOCIAL", present: false }]);
    expect(deriveLabelFilters("category:nonsense")).toEqual([]);
  });
});

describe("Gmail.search — pagination", () => {
  it("follows nextPageToken until enough candidates are collected", async () => {
    const listCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          list: async (req: any) => {
            listCalls.push(req);
            // First page returns fewer threads than requested but has more.
            if (!req.pageToken) return { data: { threads: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" } };
            return { data: { threads: [{ id: "c" }] } };
          },
          get: async (req: any) => ({
            data: { messages: [{ id: `m-${req.id}`, labelIds: ["UNREAD"], payload: { headers: [] } }] },
          }),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("from:x", 3);
    expect(res.threads.map((r) => r.threadId)).toEqual(["a", "b", "c"]);
    expect(res.nextPageToken).toBeUndefined(); // last page had no further token
    expect(listCalls[1].pageToken).toBe("p2");
    expect(listCalls[1].maxResults).toBe(1); // only what's still missing
  });

  it("skips later chunks when the first chunk already yields maxResults", async () => {
    let getCount = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const api: any = {
      users: {
        threads: {
          list: async () => ({ data: { threads: ids.map((id) => ({ id })) } }),
          get: async (req: any) => {
            getCount++;
            return { data: { messages: [{ id: `m-${req.id}`, labelIds: ["UNREAD"], payload: { headers: [] } }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("is:unread", 2);
    expect(res.threads).toHaveLength(2);
    expect(getCount).toBe(8); // exactly one GET_CONCURRENCY chunk, second chunk skipped
  });

  it("passes a caller pageToken through and surfaces the nextPageToken", async () => {
    const listCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          list: async (req: any) => {
            listCalls.push(req);
            return { data: { threads: [{ id: "d" }], nextPageToken: "p9" } };
          },
          get: async (req: any) => ({
            data: { messages: [{ id: `m-${req.id}`, labelIds: [], payload: { headers: [] } }] },
          }),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("from:x", 1, "p8");
    expect(listCalls[0].pageToken).toBe("p8");
    expect(res.threads.map((r) => r.threadId)).toEqual(["d"]);
    expect(res.nextPageToken).toBe("p9");
  });
});

describe("decodeAddressHeader — RFC 2047 text must not become address syntax", () => {
  // The attack: on the wire ONE valid mailbox (DMARC-aligned on x.example); the display
  // name is an encoded-word that DECODES to `<legit@news.example>,`. Decode-then-parse
  // would read that as a second mailbox and hand the attacker the newsletter's sender key
  // (digest grouping, list_subscriptions grouping, bulk_unsubscribe dedupe).
  const attack = "=?UTF-8?Q?=3Clegit=40news=2Eexample=3E=2C?= <evil@x.example>";
  it("keeps the real mailbox and quotes the decoded name", () => {
    expect(decodeAddressHeader(attack)).toBe('"<legit@news.example>," <evil@x.example>');
    expect(parseSender(decodeAddressHeader(attack))).toEqual({
      email: "evil@x.example",
      name: "<legit@news.example>,",
    });
  });
  it.each([
    ["=?UTF-8?Q?legit=40news=2Eexample=2C?= <evil@x.example>", '"legit@news.example," <evil@x.example>', "evil@x.example"],
    ["=?UTF-8?Q?=3Clegit=40news=2Eexample=3E?= <evil@x.example>", '"<legit@news.example>" <evil@x.example>', "evil@x.example"],
    ["=?UTF-8?Q?a=3B_b?= <evil@x.example>", '"a; b" <evil@x.example>', "evil@x.example"],
    ['=?UTF-8?Q?Say_=22hi=22?= <q@x.example>', '"Say \\"hi\\"" <q@x.example>', "q@x.example"],
  ])("%s → %s, sender key %s", (raw, shown, key) => {
    expect(decodeAddressHeader(raw)).toBe(shown);
    expect(parseSender(decodeAddressHeader(raw)).email).toBe(key);
  });
  it("renders ordinary headers as before: name, then address; comma names quoted", () => {
    expect(decodeAddressHeader("Alice Example <alice@example.com>")).toBe("Alice Example <alice@example.com>");
    expect(decodeAddressHeader("=?UTF-8?B?Tm9yZWVu?= <noreply@x.example>")).toBe("Noreen <noreply@x.example>");
    expect(decodeAddressHeader("=?iso-8859-1?Q?M=FCller=2C_Hans?= <h@x.example>")).toBe('"Müller, Hans" <h@x.example>');
    expect(parseSender(decodeAddressHeader("=?iso-8859-1?Q?M=FCller=2C_Hans?= <h@x.example>"))).toEqual({
      email: "h@x.example",
      name: "Müller, Hans",
    });
    expect(decodeAddressHeader('"Doe, Jane" <jane@x.example>')).toBe('"Doe, Jane" <jane@x.example>');
    expect(decodeAddressHeader("bob@y.example")).toBe("bob@y.example");
    expect(decodeAddressHeader("<bob@y.example>")).toBe("bob@y.example");
    expect(decodeAddressHeader("Alice (Sales) <a@x.example>")).toBe("Alice <a@x.example>");
  });
  it("falls back to plain decoded text when there is no mailbox", () => {
    expect(decodeAddressHeader("=?UTF-8?B?Tm9yZWVu?=")).toBe("Noreen");
    expect(decodeAddressHeader("")).toBe("");
    expect(decodeAddressHeader("Just A Name")).toBe("Just A Name");
  });
});

describe("decodeRfc2047", () => {
  it("decodes B-encoded UTF-8 words", () => {
    expect(decodeRfc2047("=?UTF-8?B?w6RiYw==?=")).toBe("äbc");
  });

  it("decodes Q-encoded words incl. underscore-as-space and =XX bytes", () => {
    expect(decodeRfc2047("=?ISO-8859-1?Q?Gr=FC=DFe_aus_M=FCnchen?=")).toBe("Grüße aus München");
  });

  it("collapses whitespace between adjacent encoded-words (RFC 2047 §6.2)", () => {
    expect(decodeRfc2047("=?UTF-8?B?SGFsbG8g?=\r\n =?UTF-8?B?V2VsdA==?=")).toBe("Hallo Welt");
  });

  it("decodes encoded words embedded in plain header text", () => {
    expect(decodeRfc2047('"=?UTF-8?Q?M=C3=BCller?=" <m@x.de>')).toBe('"Müller" <m@x.de>');
  });

  it("leaves undecodable or plain values untouched", () => {
    expect(decodeRfc2047("=?X-UNKNOWN-99?B?////?=")).toBe("=?X-UNKNOWN-99?B?////?=");
    expect(decodeRfc2047("plain subject")).toBe("plain subject");
  });

  it("is applied to parsed message headers", () => {
    const msg = parseMessage({
      id: "m1",
      threadId: "t1",
      payload: { headers: [{ name: "Subject", value: "=?UTF-8?B?w5xiZXJ3ZWlzdW5n?=" }] },
    });
    expect(msg.subject).toBe("Überweisung");
  });
});

describe("withBackoff", () => {
  const httpErr = (status: number) => Object.assign(new Error(`http ${status}`), { status });

  it("retries 429 with growing delays, then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls < 3) throw httpErr(429);
        return "ok";
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]); // exponential
  });

  it("gives up after the retry budget and rethrows", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw httpErr(503);
        },
        { retries: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow("http 503");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does not retry non-retryable errors (4xx, no status)", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw httpErr(404);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("http 404");
    expect(calls).toBe(1);

    await expect(withBackoff(async () => Promise.reject(new Error("plain")), { sleep: async () => {} }))
      .rejects.toThrow("plain");
  });

  it("recognizes the status on err.code (googleapis variance)", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("x"), { code: 500 });
        return 1;
      },
      { sleep: async () => {} },
    );
    expect(result).toBe(1);
    expect(calls).toBe(2);
  });

  it("recognizes a string status like code: '429'", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("x"), { code: "429" });
        return 1;
      },
      { sleep: async () => {} },
    );
    expect(result).toBe(1);
    expect(calls).toBe(2);
  });

  it("retries a transient network error (ECONNRESET / socket hang up), then succeeds", async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("read"), { code: "ECONNRESET" });
        if (calls === 2) throw new Error("socket hang up"); // no code, only the message
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up on a network error after the retry budget", async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        },
        { retries: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow("timeout");
    expect(calls).toBe(3); // initial + 2 retries, not infinite
  });
});

describe("isInvalidGrant", () => {
  it("detects the Google OAuth invalid_grant shape (response body and message)", () => {
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isInvalidGrant(new Error("invalid_grant: Token has been expired or revoked."))).toBe(true);
  });
  it("does not fire on unrelated errors", () => {
    expect(isInvalidGrant(new Error("network down"))).toBe(false);
    expect(isInvalidGrant({ response: { data: { error: "access_denied" } } })).toBe(false);
    expect(isInvalidGrant(undefined)).toBe(false);
  });
});

describe("Gmail.req — dead refresh token surfaces an actionable message", () => {
  it("rewrites invalid_grant into a run-`--auth` hint", async () => {
    const api: any = {
      users: {
        labels: {
          list: async () => {
            throw Object.assign(new Error("boom"), { response: { data: { error: "invalid_grant" } } });
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await expect(gmail.listLabels()).rejects.toThrow(/mailwarden --auth/);
  });

  it("passes a non-auth error through unchanged", async () => {
    const api: any = {
      users: { labels: { list: async () => { throw new Error("some other failure"); } } },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await expect(gmail.listLabels()).rejects.toThrow(/some other failure/);
  });
});

describe("Gmail.getThread / getThreadSubject / listThreadIdsByLabel", () => {
  it("getThread parses every message and passes the requested format", async () => {
    const getCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          get: async (req: any) => {
            getCalls.push(req);
            return {
              data: {
                messages: [
                  {
                    id: "m1",
                    threadId: "th-1",
                    payload: {
                      headers: [{ name: "Subject", value: "s1" }],
                      mimeType: "text/plain",
                      body: { data: b64url("hi") },
                    },
                  },
                  { id: "m2", threadId: "th-1", payload: { headers: [{ name: "Subject", value: "s2" }] } },
                ],
              },
            };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);

    const res = await gmail.getThread("th-1");
    expect(getCalls[0].format).toBe("full");
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({ id: "m1", subject: "s1", plaintextBody: "hi" });

    const meta = await gmail.getThread("th-1", false);
    expect(getCalls[1].format).toBe("metadata");
    expect(meta.metadataOnly).toBe(true);
  });

  it("getThread full:false OMITS body and attachment fields — it never claims an empty set", async () => {
    // The regression this guards: `metadata` format carries no payload parts, so an
    // attachment list built from it is empty for every message, including ones with a
    // 203 KB PDF attached. Shipping that as `attachments: []` reads as "no attachment"
    // and nearly got an invoice archived (reported 2026-08-26).
    const api: any = {
      users: {
        threads: {
          get: async () => ({
            data: {
              messages: [
                {
                  id: "m1",
                  threadId: "th-1",
                  labelIds: ["INBOX"],
                  payload: { headers: [{ name: "Subject", value: "Invoice" }] },
                },
              ],
            },
          }),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.getThread("th-1", false);

    expect(res.metadataOnly).toBe(true);
    const msg = res.messages[0] as Record<string, unknown>;
    // Headers survive — that is what this format is for.
    expect(msg).toMatchObject({ id: "m1", subject: "Invoice", labelIds: ["INBOX"] });
    // The three unmeasured fields are absent, not empty.
    expect("attachments" in msg).toBe(false);
    expect("plaintextBody" in msg).toBe(false);
    expect("htmlBody" in msg).toBe(false);
  });

  it("getThread full:false ASKS for the headers it parses, so an absence means the message", async () => {
    // `authentication: { unchecked: true }` is a claim about the MESSAGE — nobody checked
    // this mail. On a metadata fetch that did not ask for `Authentication-Results`, it
    // would instead be a fact about the REQUEST wearing the same words. Naming the
    // headers is what keeps the two apart; `full` needs no list because it carries all.
    const getCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          get: async (req: any) => {
            getCalls.push(req);
            return { data: { messages: [{ id: "m1", threadId: "th-1", payload: { headers: [] } }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);

    await gmail.getThread("th-1", false);
    expect(getCalls[0].metadataHeaders).toEqual([...PARSED_HEADERS]);
    expect(PARSED_HEADERS).toContain("Authentication-Results");

    await gmail.getThread("th-1", true);
    expect(getCalls[1].metadataHeaders).toBeUndefined();
  });

  it("PARSED_HEADERS covers every header the parse actually reads", () => {
    // The coupling this guards: a header read by parseMessage but missing from the list
    // is silently empty on every metadata fetch — and an empty header is indistinguishable
    // from an absent one in the result. Parsing the same message twice, once with all
    // headers and once with only the requested ones, must give the same answer.
    const headers = [
      { name: "From", value: "Mein Postkorb <noreply@brz.gv.at>" },
      { name: "To", value: "chris@example.com" },
      { name: "Subject", value: "=?UTF-8?B?R3LDvMOfZQ==?=" },
      { name: "Date", value: "Tue, 1 Sep 2026 09:00:00 +0200" },
      { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.d=brz.gv.at; spf=pass smtp.mailfrom=noreply@brz.gv.at; dmarc=pass header.from=brz.gv.at" },
      { name: "Return-Path", value: "<noreply@brz.gv.at>" },
      // Headers a metadata fetch would NOT return with the list above:
      { name: "List-Unsubscribe", value: "<https://x.example/u>" },
      { name: "Reply-To", value: "someone@elsewhere.example" },
      { name: "Message-Id", value: "<abc@brz.gv.at>" },
      { name: "Received", value: "from mail.brz.gv.at by mx.google.com" },
    ];
    const message = (hs: typeof headers) => ({ id: "m1", threadId: "t1", snippet: "…", payload: { headers: hs } });
    const requested = headers.filter((h) =>
      (PARSED_HEADERS as readonly string[]).some((n) => n.toLowerCase() === h.name.toLowerCase()),
    );

    expect(parseMessage(message(requested))).toEqual(parseMessage(message(headers)));
  });

  it("getThread full:true still carries content fields and sets no metadataOnly flag", async () => {
    const api: any = {
      users: {
        threads: {
          get: async () => ({
            data: {
              messages: [
                {
                  id: "m1",
                  threadId: "th-1",
                  payload: {
                    headers: [{ name: "Subject", value: "s" }],
                    mimeType: "text/plain",
                    body: { data: b64url("body") },
                  },
                },
              ],
            },
          }),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.getThread("th-1", true);
    expect(res.metadataOnly).toBeUndefined();
    expect(res.messages[0]).toMatchObject({ plaintextBody: "body", attachments: [] });
  });

  it("getThreadSubject uses a metadata-only fetch and defaults to empty", async () => {
    const getCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          get: async (req: any) => {
            getCalls.push(req);
            return {
              data: { messages: [{ payload: { headers: [{ name: "Subject", value: "the subject" }] } }] },
            };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.getThreadSubject("th-1")).toBe("the subject");
    expect(getCalls[0].format).toBe("metadata");
    expect(getCalls[0].metadataHeaders).toEqual(["Subject"]);

    api.users.threads.get = async () => ({ data: {} });
    expect(await gmail.getThreadSubject("th-2")).toBe("");
  });

  it("listThreadIdsByLabel paginates and filters by the exact labelIds param", async () => {
    const listCalls: any[] = [];
    const api: any = {
      users: {
        threads: {
          list: async (req: any) => {
            listCalls.push(req);
            if (!req.pageToken) return { data: { threads: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" } };
            return { data: { threads: [{ id: "c" }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.listThreadIdsByLabel("Label_7")).toEqual(["a", "b", "c"]);
    expect(listCalls[0].labelIds).toEqual(["Label_7"]);
    expect(listCalls[1].pageToken).toBe("p2");
  });
});

describe("Gmail.ensureLabel", () => {
  function fakeApi(opts: { patchFails?: unknown } = {}) {
    const created: any[] = [];
    const patched: any[] = [];
    const api: any = {
      users: {
        labels: {
          list: async () => ({
            data: {
              labels: [
                { id: "Label_9", name: "ToDo", type: "user" },
                { id: "INBOX", name: "INBOX", type: "system" },
              ],
            },
          }),
          create: async (req: any) => {
            created.push(req);
            return { data: { id: "Label_NEW" } };
          },
          patch: async (req: any) => {
            patched.push(req);
            if (opts.patchFails) throw opts.patchFails;
            return { data: { id: req.id } };
          },
        },
      },
    };
    return { api, created, patched };
  }

  const RED = { backgroundColor: "#fb4c2f", textColor: "#ffffff" };

  it("returns the existing id on a case-insensitive name match (no create)", async () => {
    const { api, created } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.ensureLabel("todo")).toBe("Label_9");
    expect(created).toHaveLength(0);
  });

  it("creates a genuinely new label", async () => {
    const { api, created } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.ensureLabel("Brand/New")).toBe("Label_NEW");
    expect(created[0].requestBody.name).toBe("Brand/New");
  });

  it("creates a new label carrying the colour in the same request", async () => {
    const { api, created, patched } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.ensureLabel("Brand/New", RED)).toBe("Label_NEW");
    expect(created[0].requestBody.color).toEqual(RED);
    expect(patched).toHaveLength(0); // one request, not create-then-recolour
  });

  it("recolours a label that already exists — the case that matters for an old snooze label", async () => {
    const { api, created, patched } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    expect(await gmail.ensureLabel("todo", RED)).toBe("Label_9");
    expect(created).toHaveLength(0);
    expect(patched[0]).toMatchObject({ id: "Label_9", requestBody: { color: RED } });
  });

  it("leaves an existing label alone when no colour is given", async () => {
    const { api, patched } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.ensureLabel("todo");
    expect(patched).toHaveLength(0);
  });

  it("refuses to colour a system label before spending a request on it", async () => {
    const { api, patched } = fakeApi();
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await expect(gmail.ensureLabel("INBOX", RED)).rejects.toThrow(/system label/);
    expect(patched).toHaveLength(0);
  });

  it("turns Gmail's bare 400 into a sentence naming the palette", async () => {
    const { api } = fakeApi({ patchFails: Object.assign(new Error("Invalid color"), { code: 400 }) });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await expect(gmail.ensureLabel("todo", { ...RED, backgroundColor: "#123456" })).rejects.toThrow(
      /palette/,
    );
  });

  it("leaves a non-400 failure to its own classification", async () => {
    // A 403 here is Google's missing-scope answer, and `req` already turns it into the
    // re-authorize message. The colour translation must not push itself in front of that:
    // telling someone to pick another colour when the token cannot write at all sends them
    // looking in the wrong place.
    const { api } = fakeApi({
      patchFails: Object.assign(new Error("Insufficient Permission"), { code: 403 }),
    });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await expect(gmail.ensureLabel("todo", RED)).rejects.toThrow(/missing a Gmail scope/);
    await expect(gmail.ensureLabel("todo", RED)).rejects.not.toThrow(/palette/);
  });
});

describe("Gmail.getProfile", () => {
  it("returns the authorized account's email address and mailbox totals", async () => {
    const api: any = {
      users: {
        getProfile: async () => ({
          data: {
            emailAddress: "me@example.com",
            messagesTotal: 4321,
            threadsTotal: 987,
            historyId: "556677", // the resume point for what_changed
          },
        }),
      },
    };
    expect(await new Gmail(api as gmail_v1.Gmail).getProfile()).toEqual({
      emailAddress: "me@example.com",
      messagesTotal: 4321,
      threadsTotal: 987,
      historyId: "556677",
    });
  });

  it("defaults each field when the API returns it null or omitted", async () => {
    const api: any = {
      users: {
        getProfile: async () => ({
          data: { emailAddress: null, messagesTotal: null }, // threadsTotal omitted entirely
        }),
      },
    };
    expect(await new Gmail(api as gmail_v1.Gmail).getProfile()).toEqual({
      emailAddress: "",
      messagesTotal: 0,
      threadsTotal: 0,
      historyId: "",
    });
  });
});

describe("isInsufficientScope", () => {
  it("is true only for a 403 that names a scope/permission problem", () => {
    expect(
      isInsufficientScope({
        code: 403,
        response: { data: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
      }),
    ).toBe(true);
    // googleapis also surfaces the reason array at the top level (version-dependent)
    expect(isInsufficientScope({ code: 403, errors: [{ reason: "insufficientPermissions" }] })).toBe(true);
    expect(isInsufficientScope({ status: 403, message: "Request had insufficient authentication scopes." })).toBe(true);
  });

  it("is false for other statuses or unrelated 403s", () => {
    expect(isInsufficientScope({ status: 404, message: "insufficient scopes" })).toBe(false);
    expect(isInsufficientScope({ status: 403, message: "quota exceeded" })).toBe(false);
    // a bare PERMISSION_DENIED (no scope reason) is a genuine denial — e.g. an admin
    // policy — which a re-auth would NOT fix, so it must NOT be treated as a scope shortfall
    expect(
      isInsufficientScope({ status: 403, response: { data: { error: { status: "PERMISSION_DENIED" } } } }),
    ).toBe(false);
    expect(isInsufficientScope(new Error("boom"))).toBe(false);
  });
});

describe("filterCriteria round-trip helpers", () => {
  it("omits empty fields and pairs size with a comparison", () => {
    expect(filterCriteriaToApi({ from: "a@b.com", hasAttachment: false })).toEqual({
      from: "a@b.com",
      hasAttachment: false,
    });
    // size without an explicit comparison defaults to "larger" (the API requires one)
    expect(filterCriteriaToApi({ size: 5_000_000 })).toEqual({ size: 5_000_000, sizeComparison: "larger" });
    expect(filterCriteriaFromApi(undefined)).toEqual({});
    expect(
      filterCriteriaFromApi({ subject: "x", sizeComparison: "unspecified" as any, size: 10 }),
    ).toEqual({ subject: "x", size: 10 }); // "unspecified" comparison dropped
  });
});

describe("filterCriteriaToQuery", () => {
  it("maps criteria onto Gmail search operators", () => {
    expect(filterCriteriaToQuery({ from: "a@b.com", subject: "invoice" })).toBe(
      'from:"a@b.com" subject:"invoice"',
    );
    expect(filterCriteriaToQuery({ query: "newer_than:7d", negatedQuery: "in:chats" })).toBe(
      "(newer_than:7d) -(in:chats)",
    );
    expect(filterCriteriaToQuery({ hasAttachment: true })).toBe("has:attachment");
    expect(filterCriteriaToQuery({ hasAttachment: false })).toBe("-has:attachment");
    expect(filterCriteriaToQuery({ excludeChats: true })).toBe("-in:chats");
    expect(filterCriteriaToQuery({ size: 5_000_000, sizeComparison: "larger" })).toBe("larger:5000000");
    // size without its comparison isn't emitted (incomplete pair)
    expect(filterCriteriaToQuery({ size: 5_000_000 })).toBe("");
    expect(filterCriteriaToQuery({})).toBe("");
  });

  it("quotes plain values so a stray ')' or operator can't break out and broaden the match", () => {
    expect(filterCriteriaToQuery({ subject: "x) OR from:(boss@corp.com" })).toBe(
      'subject:"x) OR from:(boss@corp.com"',
    );
    // Gmail has no quote-escaping → internal double quotes are stripped
    expect(filterCriteriaToQuery({ from: 'a"b@x.com' })).toBe('from:"ab@x.com"');
  });
});

describe("Gmail filters — create/list/delete", () => {
  it("createFilter resolves label names, sends label-only actions, and never forwards", async () => {
    let body: any;
    const api: any = {
      users: {
        labels: { list: async () => ({ data: { labels: [{ id: "Label_5", name: "News", type: "user" }] } }) },
        settings: {
          filters: {
            create: async (req: any) => ((body = req.requestBody), { data: { id: "f9", ...req.requestBody } }),
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const out = await gmail.createFilter({ from: "n@x.com" }, { addLabels: ["News"], removeLabels: ["INBOX"] });

    expect(body).toEqual({
      criteria: { from: "n@x.com" },
      action: { addLabelIds: ["Label_5"], removeLabelIds: ["INBOX"] },
    });
    expect(body.action).not.toHaveProperty("forward");
    expect(out.id).toBe("f9");
  });

  it("createFilter rejects empty criteria and an empty-after-resolution action (no cryptic 400)", async () => {
    const api: any = {
      users: {
        labels: { list: async () => ({ data: { labels: [] } }) },
        settings: { filters: { create: async () => ({ data: { id: "x" } }) } },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    // no usable criteria (empty object, and a field filterCriteriaToApi would drop)
    await expect(gmail.createFilter({}, { addLabels: ["INBOX"] })).rejects.toThrow(/no usable match criteria/);
    // criteria fine, but the only remove-name doesn't exist → resolves to no action
    await expect(
      gmail.createFilter({ from: "a@b.com" }, { removeLabels: ["Ghost"] }),
    ).rejects.toThrow(/no label action/);
  });

  it("listFilters returns [] when the account has no filters", async () => {
    const api: any = {
      users: { settings: { filters: { list: async () => ({ data: {} }) } } },
    };
    expect(await new Gmail(api as gmail_v1.Gmail).listFilters()).toEqual([]);
  });

  it("deleteFilter forwards the id to the settings endpoint", async () => {
    let call: any;
    const api: any = {
      users: { settings: { filters: { delete: async (req: any) => ((call = req), {}) } } },
    };
    await new Gmail(api as gmail_v1.Gmail).deleteFilter("f1");
    expect(call).toMatchObject({ userId: "me", id: "f1" });
  });

  it("maps a 403 insufficient-scope from a filter call to an actionable re-auth message", async () => {
    const api: any = {
      users: {
        settings: {
          filters: {
            list: async () => {
              // Shape Gmail returns when the token predates the settings scope.
              throw { code: 403, errors: [{ reason: "insufficientPermissions" }], message: "Insufficient Permission" };
            },
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    // Names the missing scope and the fix — not a raw 403.
    await expect(gmail.listFilters()).rejects.toThrow(/gmail\.settings\.basic/);
    await expect(gmail.listFilters()).rejects.toThrow(/mailwarden --auth/);
  });
});

describe("Gmail.trash / untrash / deleteLabel — API pass-through", () => {
  it("forwards the thread/label id to the right endpoint", async () => {
    const calls: Record<string, any> = {};
    const api: any = {
      users: {
        threads: {
          trash: async (req: any) => (calls.trash = req),
          untrash: async (req: any) => (calls.untrash = req),
        },
        labels: {
          delete: async (req: any) => (calls.delete = req),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.trash("th-1");
    await gmail.untrash("th-2");
    await gmail.deleteLabel("Label_3");
    expect(calls.trash).toMatchObject({ userId: "me", id: "th-1" });
    expect(calls.untrash).toMatchObject({ userId: "me", id: "th-2" });
    expect(calls.delete).toMatchObject({ userId: "me", id: "Label_3" });
  });
});

describe("Gmail.listHistory", () => {
  function fakeApi(pages: any[]) {
    const calls: any[] = [];
    let i = 0;
    const api: any = {
      users: {
        history: {
          list: async (req: any) => {
            calls.push(req);
            const page = pages[i++];
            if (page instanceof Error) throw page;
            return { data: page };
          },
        },
      },
    };
    return { gmail: new Gmail(api as gmail_v1.Gmail), calls };
  }

  it("folds one page and reports the mailbox's current id", async () => {
    const { gmail, calls } = fakeApi([
      {
        history: [{ id: "1", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] }],
        historyId: "555",
      },
    ]);
    const s = await gmail.listHistory("500");
    expect(s.added).toEqual([{ id: "m1", threadId: "t1" }]);
    expect(s.historyId).toBe("555");
    expect(calls[0].startHistoryId).toBe("500");
  });

  it("follows pages up to max and asks only for what is still missing", async () => {
    const page = (n: number, token?: string) => ({
      history: Array.from({ length: n }, (_, i) => ({
        id: String(i),
        messagesAdded: [{ message: { id: `m${i}`, threadId: `t${i}` } }],
      })),
      historyId: "900",
      ...(token ? { nextPageToken: token } : {}),
    });
    const { gmail, calls } = fakeApi([page(500, "p2"), page(100)]);
    const s = await gmail.listHistory("1", { max: 600 });
    expect(s.records).toBe(600);
    expect(calls[0].maxResults).toBe(500);
    expect(calls[1].maxResults).toBe(100);
    expect(calls[1].pageToken).toBe("p2");
  });

  it("passes a label filter through", async () => {
    const { gmail, calls } = fakeApi([{ history: [], historyId: "2" }]);
    await gmail.listHistory("1", { labelId: "INBOX" });
    expect(calls[0].labelId).toBe("INBOX");
  });

  it("still returns a resume point when nothing happened", async () => {
    const { gmail } = fakeApi([{ historyId: "610" }]);
    const s = await gmail.listHistory("600");
    expect(s).toMatchObject({ historyId: "610", records: 0, added: [], truncated: false });
  });

  it("turns an expired start id into an error, never into an empty result", async () => {
    // "Nothing changed" and "I can no longer tell you what changed" call for opposite
    // reactions. A catch that returned an empty summary here would be the dangerous one.
    const expired = () => Object.assign(new Error("Not Found"), { code: 404 });
    const { gmail } = fakeApi([expired(), expired()]);
    await expect(gmail.listHistory("1")).rejects.toThrow(/does NOT mean nothing changed/);
    await expect(gmail.listHistory("1")).rejects.toThrow(/get_profile/);
  });

  it("leaves other failures to their own classification", async () => {
    const { gmail } = fakeApi([Object.assign(new Error("Insufficient Permission"), { code: 403 })]);
    await expect(gmail.listHistory("1")).rejects.toThrow(/missing a Gmail scope/);
  });
});

describe("Gmail.crossCheckPredicates", () => {
  /**
   * A fake Gmail whose two routes can be made to disagree: `q` alone returns `byQuery`,
   * and a call carrying `labelIds` returns whatever that label is mapped to. That is exactly
   * the divergence the cross-check exists to catch — and cannot be produced with one route.
   */
  function fakeApi(byQuery: string[], byLabel: Record<string, string[]>) {
    const calls: any[] = [];
    const api: any = {
      users: {
        messages: {
          list: async (req: any) => {
            calls.push(req);
            const ids = req.labelIds?.length ? (byLabel[req.labelIds[0]] ?? []) : byQuery;
            return { data: { messages: ids.map((id) => ({ id, threadId: `t-${id}` })) } };
          },
        },
      },
    };
    return { gmail: new Gmail(api as gmail_v1.Gmail), calls };
  }

  const refsOf = (ids: string[]) => ids.map((id) => ({ id, threadId: `t-${id}` }));

  it("keeps everything when the query carries no derivable predicate", async () => {
    const { gmail, calls } = fakeApi(["m1"], {});
    const res = await gmail.crossCheckPredicates("from:bob", refsOf(["m1"]), 100);
    expect(res).toEqual({ kept: refsOf(["m1"]), dropped: [], checked: [], capped: false });
    expect(calls).toHaveLength(0); // nothing to compare, nothing to spend
  });

  it("drops a message the label route does not have, for a positive predicate", async () => {
    const { gmail } = fakeApi(["m1", "m2", "m3"], { UNREAD: ["m1", "m3"] });
    const res = await gmail.crossCheckPredicates("is:unread", refsOf(["m1", "m2", "m3"]), 100);
    expect(res.kept.map((r) => r.id)).toEqual(["m1", "m3"]);
    expect(res.dropped).toEqual([{ id: "m2", threadId: "t-m2", predicate: "+UNREAD" }]);
    expect(res.checked).toEqual(["+UNREAD"]);
  });

  it("drops a message the label route DOES have, for a negative predicate", async () => {
    const { gmail } = fakeApi(["m1", "m2"], { INBOX: ["m2"] });
    const res = await gmail.crossCheckPredicates("-in:inbox", refsOf(["m1", "m2"]), 100);
    expect(res.kept.map((r) => r.id)).toEqual(["m1"]);
    expect(res.dropped).toEqual([{ id: "m2", threadId: "t-m2", predicate: "-INBOX" }]);
  });

  it("costs one list per predicate, not one per message", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `m${i}`);
    const { gmail, calls } = fakeApi(many, { UNREAD: many, INBOX: [] });
    await gmail.crossCheckPredicates("is:unread -in:inbox", refsOf(many), 1000);
    expect(calls).toHaveLength(2);
  });

  it("names only the first predicate that failed, and drops the message once", async () => {
    const { gmail } = fakeApi(["m1"], { UNREAD: [], INBOX: ["m1"] });
    const res = await gmail.crossCheckPredicates("is:unread -in:inbox", refsOf(["m1"]), 100);
    expect(res.dropped).toEqual([{ id: "m1", threadId: "t-m1", predicate: "+UNREAD" }]);
    expect(res.kept).toEqual([]);
  });

  it("refuses to check a capped match set instead of dropping on a pagination artefact", async () => {
    // The match set filled `max`, so a message absent from the label list may simply be on a
    // page nobody fetched. Reporting that as a contradiction would delete mail for a bug.
    const three = refsOf(["m1", "m2", "m3"]);
    const { gmail, calls } = fakeApi(["m1", "m2", "m3"], { UNREAD: ["m1"] });
    const res = await gmail.crossCheckPredicates("is:unread", three, 3);
    expect(res).toEqual({
      kept: three,
      dropped: [],
      checked: [],
      capped: true,
      skipped: ["+UNREAD"],
    });
    expect(calls).toHaveLength(0);
  });

  it("agrees silently when both routes say the same thing", async () => {
    const { gmail } = fakeApi(["m1", "m2"], { UNREAD: ["m1", "m2"] });
    const res = await gmail.crossCheckPredicates("is:unread", refsOf(["m1", "m2"]), 100);
    expect(res.dropped).toEqual([]);
    expect(res.kept).toHaveLength(2);
  });
});

describe("Gmail.listMessageRefs / batchModifyMessages", () => {
  it("paginates messages.list and stops at the cap", async () => {
    const listCalls: any[] = [];
    const api: any = {
      users: {
        messages: {
          list: async (req: any) => {
            listCalls.push(req);
            const start = req.pageToken ? Number(req.pageToken) : 0;
            const ids = Array.from({ length: Math.min(500, req.maxResults) }, (_, i) => ({
              id: `m-${start + i}`,
              threadId: `t-${start + i}`,
            }));
            return { data: { messages: ids, nextPageToken: String(start + ids.length) } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const refs = await gmail.listMessageRefs({ query: "in:inbox", max: 750 });
    expect(refs).toHaveLength(750);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].q).toBe("in:inbox");
    expect(listCalls[0].maxResults).toBe(500);
    expect(listCalls[1].maxResults).toBe(250); // only what's still missing
    expect(listCalls[1].pageToken).toBe("500");
  });

  it("passes labelIds filtering through", async () => {
    const listCalls: any[] = [];
    const api: any = {
      users: {
        messages: {
          list: async (req: any) => {
            listCalls.push(req);
            return { data: { messages: [{ id: "m1", threadId: "t1" }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const refs = await gmail.listMessageRefs({ labelIds: ["Label_7"] });
    expect(refs).toEqual([{ id: "m1", threadId: "t1" }]);
    expect(listCalls[0].labelIds).toEqual(["Label_7"]);
    expect(listCalls[0].q).toBeUndefined();
  });

  it("chunks batchModify at 1000 ids and dedupes thread ids", async () => {
    const batchCalls: any[] = [];
    const api: any = {
      users: {
        messages: {
          batchModify: async (req: any) => {
            batchCalls.push(req.requestBody);
            return {};
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    // 1500 messages spread over 750 threads (2 messages per thread)
    const refs = Array.from({ length: 1500 }, (_, i) => ({
      id: `m-${i}`,
      threadId: `t-${Math.floor(i / 2)}`,
    }));
    const res = await gmail.batchModifyMessages(refs, ["INBOX"], ["Label_due"]);

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].ids).toHaveLength(1000);
    expect(batchCalls[1].ids).toHaveLength(500);
    expect(batchCalls[0].addLabelIds).toEqual(["INBOX"]);
    expect(batchCalls[0].removeLabelIds).toEqual(["Label_due"]);
    expect(res.submittedMessages).toBe(1500);
    expect(res.submittedThreads).toHaveLength(750);
    expect(res.failed).toHaveLength(0);
    // Nothing was read back, so nothing is claimed about what actually landed.
    expect(res.verified).toBeUndefined();
  });

  it("reports a failed chunk and still processes the remaining chunks", async () => {
    let call = 0;
    const api: any = {
      users: {
        messages: {
          batchModify: async () => {
            call++;
            if (call === 1) throw Object.assign(new Error("quota"), { status: 403 });
            return {};
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const refs = Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}`, threadId: `t-${i}` }));
    const res = await gmail.batchModifyMessages(refs, ["INBOX"], []);

    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].messageIds).toHaveLength(1000);
    expect(res.failed[0].error).toBe("quota");
    expect(res.submittedMessages).toBe(500); // second chunk still went through
    expect(res.submittedThreads).toHaveLength(500);
  });

  it("verify:true reads labels back and reports what actually landed", async () => {
    const getCalls: string[] = [];
    const api: any = {
      users: {
        messages: { batchModify: async () => ({}) },
        threads: {
          get: async (req: any) => {
            getCalls.push(req.id);
            // t1: both messages carry the change. t2: m3 was silently ignored by
            // batchModify (still INBOX, no ToDo) — the case a submitted count hides.
            if (req.id === "t1") {
              return {
                data: {
                  messages: [
                    { id: "m1", labelIds: ["Label_todo"] },
                    { id: "m2", labelIds: ["Label_todo", "STARRED"] },
                  ],
                },
              };
            }
            return { data: { messages: [{ id: "m3", labelIds: ["INBOX"] }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const refs = [
      { id: "m1", threadId: "t1" },
      { id: "m2", threadId: "t1" },
      { id: "m3", threadId: "t2" },
    ];
    const res = await gmail.batchModifyMessages(refs, ["Label_todo"], ["INBOX"], { verify: true });

    expect(res.submittedMessages).toBe(3); // what we asked for
    expect(res.verified).toEqual({ applied: 2, notApplied: ["m3"], unverifiable: [] });
    // One read per THREAD, not per message — three messages, two gets.
    expect(getCalls.sort()).toEqual(["t1", "t2"]);
  });

  it("verify uses threads.get (the allowed endpoint), format minimal", async () => {
    const reqs: any[] = [];
    const api: any = {
      users: {
        messages: { batchModify: async () => ({}) },
        threads: {
          get: async (req: any) => {
            reqs.push(req);
            return { data: { messages: [{ id: "m1", labelIds: ["INBOX"] }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.batchModifyMessages([{ id: "m1", threadId: "t1" }], ["INBOX"], [], {
      verify: true,
    });
    expect(reqs[0]).toMatchObject({ userId: "me", id: "t1", format: "minimal" });
  });

  it("a thread that cannot be re-read makes its messages unverifiable, not failed", async () => {
    const api: any = {
      users: {
        messages: { batchModify: async () => ({}) },
        threads: {
          get: async (req: any) => {
            if (req.id === "t2") throw Object.assign(new Error("gone"), { status: 404 });
            return { data: { messages: [{ id: "m1", labelIds: ["Label_todo"] }] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.batchModifyMessages(
      [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      ["Label_todo"],
      [],
      { verify: true },
    );
    expect(res.verified).toEqual({ applied: 1, notApplied: [], unverifiable: ["m2"] });
    expect(res.failed).toHaveLength(0); // the batch itself was fine
  });

  it("does not verify a chunk that failed — only submitted ids are checked", async () => {
    let call = 0;
    const api: any = {
      users: {
        messages: {
          batchModify: async () => {
            call++;
            if (call === 1) throw Object.assign(new Error("quota"), { status: 403 });
            return {};
          },
        },
        threads: {
          get: async () => ({ data: { messages: [{ id: "m-1000", labelIds: ["Label_x"] }] } }),
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const refs = Array.from({ length: 1001 }, (_, i) => ({ id: `m-${i}`, threadId: `t-${i}` }));
    const res = await gmail.batchModifyMessages(refs, ["Label_x"], [], { verify: true });
    expect(res.failed[0].messageIds).toHaveLength(1000);
    expect(res.submittedMessages).toBe(1);
    expect(res.verified).toEqual({ applied: 1, notApplied: [], unverifiable: [] });
  });

  it("skips the read-back entirely when nothing was submitted", async () => {
    let gets = 0;
    const api: any = {
      users: {
        messages: {
          batchModify: async () => {
            throw Object.assign(new Error("quota"), { status: 403 });
          },
        },
        threads: {
          get: async () => {
            gets++;
            return { data: { messages: [] } };
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.batchModifyMessages([{ id: "m1", threadId: "t1" }], ["INBOX"], [], {
      verify: true,
    });
    expect(res.submittedMessages).toBe(0);
    expect(res.verified).toBeUndefined();
    expect(gets).toBe(0);
  });

  it("resolves label names for batch calls (same rules as modifyLabels)", async () => {
    const batchCalls: any[] = [];
    const api: any = {
      users: {
        labels: {
          list: async () => ({
            data: { labels: [{ id: "Label_todo", name: "ToDo", type: "user" }] },
          }),
        },
        messages: {
          batchModify: async (req: any) => {
            batchCalls.push(req.requestBody);
            return {};
          },
        },
      },
    };
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.batchModifyMessages([{ id: "m1", threadId: "t1" }], ["ToDo"], ["DoesNotExist"]);
    expect(batchCalls[0].addLabelIds).toEqual(["Label_todo"]);
    expect(batchCalls[0].removeLabelIds).toEqual([]); // unknown name in remove → skipped
  });
});

describe("Gmail.downloadAttachment", () => {
  const apiWith = (data: string | null) =>
    ({
      users: { messages: { attachments: { get: async () => ({ data: { data } }) } } },
    }) as unknown as gmail_v1.Gmail;

  let tmp: string;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("decodes base64url and creates missing destination directories", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    const gmail = new Gmail(apiWith(b64url("PDFDATA")));
    const dest = path.join(tmp, "sub", "dir", "file.pdf"); // sub/dir does not exist yet
    const saved = await gmail.downloadAttachment("m1", "a1", dest);
    expect(saved).toBe(path.resolve(dest));
    expect(await fs.readFile(saved, "utf8")).toBe("PDFDATA");
  });

  it("resolves a relative destPath inside MAILWARDEN_DOWNLOAD_DIR", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    vi.stubEnv("MAILWARDEN_DOWNLOAD_DIR", tmp);
    const gmail = new Gmail(apiWith(b64url("X")));
    const saved = await gmail.downloadAttachment("m1", "a1", "inbox/file.bin");
    // fence paths are realpath-canonicalized (e.g. /var → /private/var on macOS)
    expect(saved).toBe(path.join(await fs.realpath(tmp), "inbox", "file.bin"));
    expect(await fs.readFile(saved, "utf8")).toBe("X");
  });

  it("never overwrites: an existing file gets a numeric suffix", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    const gmail = new Gmail(apiWith(b64url("NEW")));
    const dest = path.join(tmp, "report.pdf");
    await fs.writeFile(dest, "OLD");
    const saved = await gmail.downloadAttachment("m1", "a1", dest);
    expect(saved).toBe(path.join(tmp, "report-1.pdf"));
    expect(await fs.readFile(dest, "utf8")).toBe("OLD"); // original untouched
    expect(await fs.readFile(saved, "utf8")).toBe("NEW");
  });

  it.skipIf(process.platform === "win32")(
    "accepts an absolute destPath under a symlinked fence root (e.g. macOS /tmp)",
    async () => {
      const target = await fs.mkdtemp(path.join(os.tmpdir(), "mw-real-"));
      tmp = target;
      const link = path.join(os.tmpdir(), `mw-link-${Date.now()}`);
      await fs.symlink(target, link, "dir");
      try {
        vi.stubEnv("MAILWARDEN_DOWNLOAD_DIR", link); // root as configured is a symlink
        const gmail = new Gmail(apiWith(b64url("X")));
        // absolute path spelled via the symlinked root, not the canonical one
        const saved = await gmail.downloadAttachment("m1", "a1", path.join(link, "file.bin"));
        expect(saved).toBe(path.join(await fs.realpath(target), "file.bin"));
        expect(await fs.readFile(saved, "utf8")).toBe("X");
      } finally {
        await fs.rm(link, { force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked subdirectory pointing outside the fence",
    async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mw-out-"));
      try {
        vi.stubEnv("MAILWARDEN_DOWNLOAD_DIR", tmp);
        await fs.symlink(outside, path.join(tmp, "leak"), "dir");
        const gmail = new Gmail(apiWith(b64url("X")));
        await expect(gmail.downloadAttachment("m1", "a1", "leak/evil.bin")).rejects.toThrow(
          /symlink/,
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("rejects a destPath escaping MAILWARDEN_DOWNLOAD_DIR", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    vi.stubEnv("MAILWARDEN_DOWNLOAD_DIR", tmp);
    const gmail = new Gmail(apiWith(b64url("X")));
    await expect(gmail.downloadAttachment("m1", "a1", "../evil.txt")).rejects.toThrow(/escapes/);
    await expect(
      gmail.downloadAttachment("m1", "a1", path.join(os.tmpdir(), "evil.txt")),
    ).rejects.toThrow(/escapes/);
  });

  it("throws when the attachment has no data", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    const gmail = new Gmail(apiWith(null));
    await expect(gmail.downloadAttachment("m1", "a1", path.join(tmp, "f"))).rejects.toThrow(/no data/);
  });

  it("gives up after 100 taken filenames instead of looping forever", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-dl-"));
    // Occupy report.pdf and report-1.pdf … report-99.pdf — all 100 candidates.
    await fs.writeFile(path.join(tmp, "report.pdf"), "x");
    for (let i = 1; i < 100; i++) await fs.writeFile(path.join(tmp, `report-${i}.pdf`), "x");
    const gmail = new Gmail(apiWith(b64url("NEW")));
    await expect(
      gmail.downloadAttachment("m1", "a1", path.join(tmp, "report.pdf")),
    ).rejects.toThrow(/No free filename/);
  });
});

/**
 * The bulk tools act on the raw index — re-verification costs a fetch per hit and a bulk op is
 * sized in thousands. The 15.08.2026 measurement priced that trade: on a drifting mailbox
 * `category:updates is:unread` matches 131 threads of which 17 are genuinely unread, so a bulk
 * archive over it moves 114 threads the caller had already read. The result now names the
 * conditions it took on trust, so a model can route through `search` when precision matters.
 */
describe("unverifiedPredicates — what the bulk tools took on the index's word", () => {
  it("names the read-state condition a bulk op cannot vouch for", () => {
    expect(unverifiedPredicates("category:updates is:unread")).toEqual([
      "+CATEGORY_UPDATES",
      "+UNREAD",
    ]);
  });

  it("marks a negated condition as such — the caller has to know which way to check", () => {
    expect(unverifiedPredicates("is:unread -in:inbox")).toEqual(["+UNREAD", "-INBOX"]);
  });

  it("is empty when nothing in the query maps to a label", () => {
    // `from:`/`older_than:` are not read-state: the index can be stale about them too, but not in
    // a way these predicates describe, so claiming otherwise would be noise.
    expect(unverifiedPredicates("from:shop@example.com older_than:30d")).toEqual([]);
  });

  it("stays empty for a query search itself would not post-filter", () => {
    // Same rule as deriveLabelFilters: boolean grouping disables the whole mechanism, so there is
    // no predicate we could claim to have skipped — we would not have checked it either way.
    expect(unverifiedPredicates("(is:unread OR is:starred)")).toEqual([]);
  });

  it("reports exactly what search would have re-verified — one source, two readers", () => {
    const q = "category:promotions is:read -in:inbox";
    expect(unverifiedPredicates(q)).toHaveLength(deriveLabelFilters(q).length);
  });
});
