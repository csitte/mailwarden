import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerTools, servedTiers } from "../src/tools.js";
import { registerPrompts } from "../src/prompts.js";
import { enterDemoMode, leaveDemoModeForTests, demoMode } from "../src/source.js";
import { createDemoMailbox, parseRawMessage } from "../src/demo-api.js";
import { demoMailboxSpec, demoSnoozeLabel } from "../src/demo-mailbox.js";
import { demoRequested, CliError } from "../src/cli.js";
import { getAuth, hasFilterScope } from "../src/auth.js";
import { Gmail } from "../src/gmail.js";
import { resetContactedSenders } from "../src/unsubscribe.js";

// The demo must not need — or touch — an authorization. getAuth throws if anything calls it, and
// hasFilterScope says the (absent) token lacks the filters scope: a demo that consulted it would
// hide the filter tools.
vi.mock("../src/auth.js", () => ({
  getAuth: vi.fn(async () => {
    throw new Error("demo mode called getAuth");
  }),
  hasFilterScope: vi.fn(() => false),
  readGrantedScopes: vi.fn(async () => ({ known: false, reason: "no-token" })),
  activeAccount: vi.fn(() => undefined),
}));

const NOW = Date.UTC(2026, 10, 25, 12);
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mw-demo-"));
});
afterEach(async () => {
  leaveDemoModeForTests();
  // "At most one request per sender" holds for the whole process; each test starts afresh.
  resetContactedSenders();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function connectDemo(tiers = "read,manage,filters,drafts") {
  vi.stubEnv("MAILWARDEN_TOOLS", tiers);
  enterDemoMode(NOW);
  const server = new McpServer({ name: "mailwarden", version: "0.0.0" });
  registerTools(server);
  registerPrompts(server, servedTiers());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) {
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      throw new Error(`${name} failed: ${text}`);
    }
    return r.structuredContent as Record<string, any>;
  };
  return { client, call };
}

describe("--demo: every tool runs against the invented mailbox", () => {
  it("answers all 33 tools with no network, no token and no error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, call } = await connectDemo();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toHaveLength(33);
    const called = new Set<string>();
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      called.add(name);
      return call(name, args);
    };

    await run("get_profile");
    await run("search", { query: "in:inbox" });
    await run("get_thread", { threadId: "t04-statement" });
    await run("read_attachment", { messageId: "t04-statement-m1", attachmentId: "t04-statement-m1-a1" });
    await run("list_labels");
    await run("list_snoozed");
    await run("triage_digest");
    await run("follow_ups");
    await run("list_unsubscribe", { threadId: "t06-byte-182" });
    await run("list_subscriptions");
    await run("create_label", { name: "Demo/Tried" });
    await run("modify_labels", { threadId: "t20-hike", add: ["Demo/Tried"] });
    const bulk = await run("bulk_modify", { query: "from:deals@trailhead-outfitters.example", remove: ["INBOX"], undo: true });
    await run("undo_bulk_modify", { steps: bulk.undo.steps });
    await run("archive", { threadId: "t11-garden" });
    await run("mark_read", { threadId: "t16-social" });
    await run("mark_unread", { threadId: "t16-social" });
    await run("trash", { threadId: "t19-lunch" });
    await run("untrash", { threadId: "t19-lunch" });
    await run("download_attachment", {
      messageId: "t02-budget-m2",
      attachmentId: "t02-budget-m2-a1",
      destPath: path.join(tmp, "budget-q4.csv"),
    });
    await run("export_thread", { threadId: "t01-phishing", destPath: path.join(tmp, "phish.md") });
    await run("unsubscribe", { threadId: "t06-byte-182" });
    await run("bulk_unsubscribe", { threadIds: ["t07-byte-181"], dryRun: true });
    await run("snooze", { threadId: "t20-hike", until: "tomorrow" });
    await run("unsnooze", { threadId: "t20-hike" });
    await run("sweep_snoozed", { dryRun: true });
    await run("list_filters");
    await run("preview_filter", { from: "digest@gardenclub.example", addLabels: ["Newsletters"] });
    const filter = await run("create_filter", { from: "digest@gardenclub.example", addLabels: ["Newsletters"] });
    await run("delete_filter", { id: filter.id });
    const draft = await run("create_draft", { threadId: "t02-budget", body: "Thanks Maya, I will review it by Friday." });
    await run("update_draft", { draftId: draft.draftId, messageId: draft.messageId, body: "Thanks Maya — reviewed, see my notes." });
    await run("what_changed", { sinceHistoryId: "400000" });

    expect([...called].sort()).toEqual(names);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(tmp, "budget-q4.csv"), "utf8")).toContain("Travel,9400,14800");
  });

  it("says it is a demo: in the instructions' place, in get_profile, and serves the filter tools whatever a token says", async () => {
    const { client, call } = await connectDemo("read,filters");
    const profile = await call("get_profile");
    expect(profile).toMatchObject({ emailAddress: "you@example.com", account: "(demo)", demo: true });
    expect(hasFilterScope()).toBe(false);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("create_filter");
    expect(demoMode()).toBe(true);
  });

  it("shows the drift search re-verifies: the index answers four threads, search returns the two really unread", async () => {
    const { call } = await connectDemo();
    const box = enterDemoMode(NOW);
    const raw = await box.api().users.threads.list({ userId: "me", q: "category:updates is:unread -in:inbox" });
    expect(raw.data.threads!.map((t) => t.id).sort()).toEqual(["t12-shipped", "t13-delivered", "t14-usage", "t15-dmarc"]);
    const res = await call("search", { query: "category:updates is:unread -in:inbox" });
    expect(res.threads.map((t: { threadId: string }) => t.threadId).sort()).toEqual(["t14-usage", "t15-dmarc"]);
    // The message index has no drift, as measured: the same query there answers two.
    const msgs = await box.api().users.messages.list({ userId: "me", q: "category:updates is:unread -in:inbox" });
    expect(msgs.data.messages!.map((x) => x.threadId).sort()).toEqual(["t14-usage", "t15-dmarc"]);
  });

  it("gives the phishing check something true to find", async () => {
    const { call } = await connectDemo();
    const t = await call("get_thread", { threadId: "t01-phishing", links: true, bodies: "none" });
    const msg = t.messages[0];
    expect(msg.hiddenTextChars).toBeGreaterThan(100);
    expect(msg.links[0]).toMatchObject({ text: "https://ledgerline.example/secure", host: "ledgerline-verify.example.net" });
    expect(msg.authentication).toMatchObject({ authservId: "mx.google.com", dmarc: "none", headerFrom: "ledgerline-verify.example.net" });
    const digest = await call("triage_digest");
    expect(digest.signals).toMatchObject({ displayNameSpoof: 1, replyToMismatch: 1, lookalikeDomain: 1, calendar: 1 });
    const genuine = await call("get_thread", { threadId: "t04-statement", bodies: "none" });
    expect(genuine.messages[0].authentication).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", dkimAligned: true });
  });

  it("unsubscribes without a request leaving the process, and records the sender as contacted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { call } = await connectDemo();
    const res = await call("unsubscribe", { threadId: "t08-byte-180" });
    expect(res).toMatchObject({ unsubscribed: true, status: 200, url: "https://weeklybyte.example/unsubscribe/one-click/k7f2" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The same sender's other issue is refused, as it would be against Gmail: one request per sender.
    const again = await call("unsubscribe", { threadId: "t07-byte-181" });
    expect(again).toMatchObject({ unsubscribed: false, duplicateOf: "t08-byte-180" });
  });

  it("keeps every change in memory: archive, trash and untrash, a draft in its thread, history of each", async () => {
    const { call } = await connectDemo();
    const before = (await call("get_profile")).historyId;
    await call("archive", { threadId: "t20-hike" });
    expect((await call("search", { query: "in:inbox from:priya.n@example.org" })).threads).toEqual([]);
    await call("trash", { threadId: "t05-offsite" });
    expect((await call("search", { query: "from:maya.chen@northpeak.example subject:offsite" })).threads).toEqual([]);
    expect((await call("search", { query: "in:trash subject:offsite" })).threads).toHaveLength(1);
    await call("untrash", { threadId: "t05-offsite" });
    // Out of the trash but not back in the inbox, as the tool's description says and Gmail does.
    expect((await call("search", { query: "in:trash subject:offsite" })).threads).toEqual([]);
    expect((await call("search", { query: "in:inbox subject:offsite" })).threads).toEqual([]);
    expect((await call("search", { query: "subject:offsite" })).threads).toHaveLength(1);
    const draft = await call("create_draft", { threadId: "t02-budget", body: "Thanks — reviewing it today." });
    expect(draft).toMatchObject({ threadId: "t02-budget", sent: false, marked: true });
    const thread = await call("get_thread", { threadId: "t02-budget", bodies: "text" });
    expect(thread.messages.at(-1).plaintextBody).toContain("reviewing it today");
    const changed = await call("what_changed", { sinceHistoryId: before });
    expect(changed.labelsRemoved.map((x: { labelId: string }) => x.labelId)).toContain("INBOX");
    expect(changed.added.length).toBeGreaterThan(0);
  });

  it("attaches no file from the disk, even with MAILWARDEN_ATTACH_DIR set", async () => {
    await fs.writeFile(path.join(tmp, "token.json"), "CANARY");
    vi.stubEnv("MAILWARDEN_ATTACH_DIR", tmp);
    const { call } = await connectDemo();
    await expect(
      call("create_draft", { threadId: "t02-budget", body: "x", attachments: [{ path: "token.json" }] }),
    ).rejects.toThrow(/off in --demo/);
  });

  it("a second server in the same process sees the same mailbox — HTTP builds one per request", async () => {
    const first = await connectDemo();
    await first.call("archive", { threadId: "t20-hike" });
    const second = await connectDemo();
    expect((await second.call("search", { query: "in:inbox from:priya.n@example.org" })).threads).toEqual([]);
  });
});

describe("the demo API's Gmail behaviour", () => {
  it("answers 404 for an unknown thread, 409 for a label name that exists, 404 for history it does not hold", async () => {
    const api = createDemoMailbox(NOW).api();
    await expect(api.users.threads.get({ userId: "me", id: "nope" })).rejects.toMatchObject({ code: 404 });
    await expect(api.users.labels.create({ userId: "me", requestBody: { name: "receipts" } })).rejects.toMatchObject({ code: 409 });
    await expect(api.users.history.list({ userId: "me", startHistoryId: "12" })).rejects.toMatchObject({ code: 404 });
    await expect(
      api.users.threads.modify({ userId: "me", id: "t20-hike", requestBody: { addLabelIds: ["Label_999"] } }),
    ).rejects.toMatchObject({ code: 400 });
    await expect(api.users.threads.list({ userId: "me", q: "", pageToken: "abc" })).rejects.toMatchObject({ code: 400 });
    const ids = Array.from({ length: 1001 }, (_, i) => `m${i}`);
    await expect(
      api.users.messages.batchModify({ userId: "me", requestBody: { ids, addLabelIds: ["STARRED"] } }),
    ).rejects.toMatchObject({ code: 400 });
  });

  it("reads a broken RFC 2231 file name as written instead of throwing", () => {
    const raw = [
      "From: you@example.com",
      "To: maya.chen@northpeak.example",
      "Subject: x",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hi",
      "--B",
      "Content-Type: application/pdf; name*=UTF-8''%zz.pdf",
      "Content-Disposition: attachment; filename*=UTF-8''%zz.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "aGk=",
      "--B--",
      "",
    ].join(String.fromCharCode(13, 10));
    expect(() => parseRawMessage(raw)).not.toThrow();
  });

  it("leaves trash and spam out of a search that does not name them", async () => {
    const g = new Gmail(createDemoMailbox(NOW).api());
    expect((await g.search("prize", 10)).threads).toEqual([]);
    expect((await g.search("in:spam prize", 10)).threads.map((t) => t.threadId)).toEqual(["t18-spam"]);
    expect((await g.search("lunch", 10)).threads).toEqual([]);
    expect((await g.search("in:trash lunch", 10)).threads.map((t) => t.threadId)).toEqual(["t19-lunch"]);
  });

  it("pages a long result", async () => {
    const api = createDemoMailbox(NOW).api();
    const first = await api.users.threads.list({ userId: "me", q: "", maxResults: 5 });
    expect(first.data.threads).toHaveLength(5);
    const second = await api.users.threads.list({ userId: "me", q: "", maxResults: 5, pageToken: first.data.nextPageToken });
    expect(second.data.threads![0].id).not.toBe(first.data.threads![0].id);
  });

  it("dates every message from the start, so relative queries hold on any day", async () => {
    for (const now of [NOW, Date.UTC(2031, 0, 1)]) {
      const g = new Gmail(createDemoMailbox(now).api());
      expect((await g.search("newer_than:1d", 25)).threads.map((t) => t.threadId).sort()).toEqual(
        ["t01-phishing", "t16-social", "t21-lookalike"],
      );
    }
    expect(demoSnoozeLabel(NOW)).toBe("MCP/Snoozed/2026-11-26");
  });

  it("uses only invented domains under .example", () => {
    const spec = JSON.stringify(demoMailboxSpec(NOW));
    const domains = new Set([...spec.matchAll(/@([a-z0-9.Ѐ-ӿ-]+)/gi)].map((m) => m[1].toLowerCase()));
    for (const d of domains) expect(d, d).toMatch(/\.example(\.(net|org|biz))?$|^example\.(com|org)$/);
  });

  it("reads a draft's raw MIME back: headers, text, HTML, a base64 attachment with an encoded name", () => {
    const CRLF = String.fromCharCode(13, 10);
    const raw = [
      "From: you@example.com",
      "To: maya.chen@northpeak.example",
      "Subject: Re: Q4 budget",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      'Content-Type: multipart/alternative; boundary="b2"',
      "",
      "--b2",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Gr=C3=BC=C3=9Fe, the notes are attached.",
      "--b2",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Notes attached.</p>",
      "--b2--",
      "--b1",
      "Content-Type: text/csv",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename*=UTF-8''notes%20f%C3%BCr%20M%C3%A4rz.csv",
      "",
      Buffer.from("a,b\r\n1,2\r\n").toString("base64"),
      "--b1--",
      "",
    ].join(CRLF);
    const parsed = parseRawMessage(raw);
    expect(parsed.headers.find((h) => h.name === "Subject")?.value).toBe("Re: Q4 budget");
    expect(parsed.text).toBe("Grüße, the notes are attached.");
    expect(parsed.html).toBe("<p>Notes attached.</p>");
    expect(parsed.attachments).toEqual([{ filename: "notes für März.csv", mimeType: "text/csv", data: Buffer.from("a,b\r\n1,2\r\n") }]);
  });
});

describe("demoRequested", () => {
  it("is off without the flag and on with it, also next to --http", () => {
    expect(demoRequested([])).toBe(false);
    expect(demoRequested(["--http"])).toBe(false);
    expect(demoRequested(["--demo"])).toBe(true);
    expect(demoRequested(["--demo", "--http"])).toBe(true);
  });

  it.each([["--auth"], ["--sweep"], ["--check"], ["--doctor"], ["--account", "work"], ["--account=work"]])(
    "refuses --demo with %s, which acts on a real mailbox",
    (...flag) => {
      expect(() => demoRequested(["--demo", ...flag])).toThrow(CliError);
    },
  );

  it.each([["--demo=1"], ["--Demo"], ["-demo"], ["--DEMO"], ["--demo=true", "--http"], ["--demos"]])(
    "refuses the near miss %s instead of serving the real mailbox",
    (...args) => {
      expect(() => demoRequested(args)).toThrow(/write exactly `--demo`/);
    },
  );

  it("refuses a bare word next to --demo", () => {
    expect(() => demoRequested(["--demo", "stray"])).toThrow(/Unexpected argument 'stray'/);
  });
});
