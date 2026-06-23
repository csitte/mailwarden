import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import {
  collectAttachments,
  collectBodies,
  isRealAttachment,
  referencedCids,
  looksLikeLabelId,
  deriveLabelFilters,
  threadMatchesFilters,
  Gmail,
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
    expect(res.map((r) => r.threadId)).toEqual(["a", "c"]);
  });

  it("over-scans candidates (full page) when filtering so maxResults stays meaningful", async () => {
    const { api, stats } = fakeSearchApi({ a: ["UNREAD"] });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.search("is:unread", 25);
    expect(stats().listMaxResults).toBe(100); // FILTER_SCAN_CAP, not 25
  });

  it("stops fetching once maxResults genuine matches are found (early break)", async () => {
    const { api, stats } = fakeSearchApi({
      a: ["UNREAD"],
      b: ["UNREAD"],
      c: ["UNREAD"], // should never be fetched once 2 are collected
    });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    const res = await gmail.search("is:unread", 2);
    expect(res.map((r) => r.threadId)).toEqual(["a", "b"]);
    expect(stats().getCount).toBe(2);
  });

  it("leaves an unfiltered query untouched (lists exactly maxResults)", async () => {
    const { api, stats } = fakeSearchApi({ a: ["INBOX"], b: ["INBOX"] });
    const gmail = new Gmail(api as gmail_v1.Gmail);
    await gmail.search("from:foo@bar.com", 25);
    expect(stats().listMaxResults).toBe(25); // no over-scan when nothing to verify
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
