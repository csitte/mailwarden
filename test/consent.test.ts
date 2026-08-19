import { describe, it, expect } from "vitest";
import { parseCallback, resolveRedirect, listenPortFor, browserCommand } from "../src/consent.js";
import { checkCredentials } from "../src/auth.js";

const STATE = "s".repeat(43); // the shape crypto.randomBytes(32).toString("base64url") produces
const EXPECT = { path: "/", state: STATE };

describe("parseCallback — what a request to the loopback server means", () => {
  it("accepts the callback it was waiting for", () => {
    expect(parseCallback(`/?code=abc&state=${STATE}`, EXPECT)).toEqual({ ok: true, code: "abc" });
  });

  it("ignores a request to another path without ending the flow", () => {
    // A browser fetching /favicon.ico must not abort a consent that is still in flight.
    const r = parseCallback("/favicon.ico", EXPECT);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 404, reason: null });
  });

  it("ignores an unparseable request line without ending the flow", () => {
    expect(parseCallback(undefined, EXPECT)).toMatchObject({ ok: false, reason: null });
  });

  it("rejects a callback whose state does not match, before looking at the code", () => {
    const r = parseCallback(`/?code=abc&state=${"x".repeat(43)}`, EXPECT);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 400 });
    expect((r as { reason: string }).reason).toMatch(/wrong state/i);
  });

  it("rejects a callback with no state at all", () => {
    const r = parseCallback("/?code=abc", EXPECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/wrong state/i);
  });

  it("does not accept a state that merely shares a prefix", () => {
    const r = parseCallback(`/?code=abc&state=${STATE.slice(0, 20)}`, EXPECT);
    expect(r.ok).toBe(false);
  });

  it("reports a declined consent in the user's terms", () => {
    const r = parseCallback(`/?error=access_denied&state=${STATE}`, EXPECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/declined/i);
  });

  it("passes any other Google error through by name", () => {
    const r = parseCallback(`/?error=admin_policy_enforced&state=${STATE}`, EXPECT);
    expect((r as { reason: string }).reason).toMatch(/admin_policy_enforced/);
  });

  it("treats an error callback as terminal even without a valid state", () => {
    // Google sends `error` back on the redirect it was given; refusing it for a state mismatch
    // would leave the user staring at a browser tab while the CLI waits for a code that will
    // never come.
    const r = parseCallback("/?error=access_denied", EXPECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string | null }).reason).not.toBeNull();
  });

  it("rejects a state-valid callback that carries no code", () => {
    const r = parseCallback(`/?state=${STATE}`, EXPECT);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/no authorization code/i);
  });

  it("never echoes anything from the query string into the response body", () => {
    const payload = "<script>alert(1)</script>";
    const bodies = [
      parseCallback(`/?error=${encodeURIComponent(payload)}&state=${STATE}`, EXPECT),
      parseCallback(`/?code=${encodeURIComponent(payload)}`, EXPECT),
      parseCallback(`/${encodeURIComponent(payload)}`, EXPECT),
    ].map((r) => (r.ok ? "" : r.body));
    for (const body of bodies) expect(body).not.toContain("script");
  });

  it("matches the callback on a non-root path when that is what was registered", () => {
    const at = { path: "/oauth2callback", state: STATE };
    expect(parseCallback(`/oauth2callback?code=abc&state=${STATE}`, at)).toEqual({
      ok: true,
      code: "abc",
    });
    expect(parseCallback(`/?code=abc&state=${STATE}`, at)).toMatchObject({ reason: null });
  });
});

describe("resolveRedirect / listenPortFor — the URI Google will match", () => {
  it("gives a desktop client the ephemeral port it actually got", () => {
    expect(resolveRedirect("http://localhost", "installed", 54321)).toEqual({
      url: "http://localhost:54321/",
      path: "/",
    });
    expect(listenPortFor("http://localhost", "installed")).toBe(0);
  });

  it("keeps a desktop client's registered path", () => {
    expect(resolveRedirect("http://localhost:3000/oauth2callback", "installed", 41111)).toEqual({
      url: "http://localhost:41111/oauth2callback",
      path: "/oauth2callback",
    });
  });

  it("leaves a web client's registered port alone — Google matches it exactly", () => {
    expect(resolveRedirect("http://localhost:8080/cb", "web", 999)).toEqual({
      url: "http://localhost:8080/cb",
      path: "/cb",
    });
    expect(listenPortFor("http://localhost:8080/cb", "web")).toBe(8080);
  });

  it("defaults a portless web redirect to 80 rather than to a random port", () => {
    expect(listenPortFor("http://localhost/cb", "web")).toBe(80);
  });
});

describe("browserCommand — handing the URL to the platform intact", () => {
  // The real shape: several `&`, and percent-encoding in the values.
  const URL_ =
    "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A62089%2F" +
    "&access_type=offline&prompt=consent&state=Ab_9-x&response_type=code";

  it("caret-escapes every & for cmd, and asks for a verbatim command line", () => {
    // Regression: without this, cmd treats `&` as a command separator, the browser gets only the
    // part before the first one, and Google answers "Required parameter is missing: response_type"
    // — a message that points at the request rather than at how it was opened. Seen live.
    const { cmd, args, verbatim } = browserCommand(URL_, "win32");
    expect(cmd).toBe("cmd");
    expect(verbatim).toBe(true);
    const passed = args[args.length - 1];
    expect(passed).not.toMatch(/[^^]&/); // no bare & survives
    expect(passed.match(/\^&/g)).toHaveLength(URL_.match(/&/g)!.length);
    // Undoing the escape must give back exactly the URL — nothing added, nothing dropped.
    expect(passed.replace(/\^&/g, "&")).toBe(URL_);
  });

  it("keeps start's empty title argument, so the URL is not taken as the window title", () => {
    const { args } = browserCommand(URL_, "win32");
    expect(args.slice(0, 3)).toEqual(["/c", "start", ""]);
  });

  it("leaves percent-encoding untouched", () => {
    const passed = browserCommand(URL_, "win32").args.at(-1)!;
    expect(passed).toContain("http%3A%2F%2Flocalhost%3A62089%2F");
  });

  it("passes the URL through unchanged on macOS and Linux", () => {
    expect(browserCommand(URL_, "darwin")).toEqual({ cmd: "open", args: [URL_], verbatim: false });
    expect(browserCommand(URL_, "linux")).toEqual({
      cmd: "xdg-open",
      args: [URL_],
      verbatim: false,
    });
  });
});

describe("checkCredentials — redirect URI validation (was local-auth's job)", () => {
  const P = "/cfg/credentials.json";
  const cred = (over: Record<string, unknown>) =>
    JSON.stringify({ installed: { client_id: "cid", client_secret: "cs", ...over } });

  it("accepts a loopback redirect on localhost", () => {
    expect(checkCredentials(cred({ redirect_uris: ["http://localhost"] }), P)).toMatchObject({
      ok: true,
      redirect_uri: "http://localhost",
    });
  });

  it("accepts 127.0.0.1 as well", () => {
    expect(checkCredentials(cred({ redirect_uris: ["http://127.0.0.1:1234/cb"] }), P)).toMatchObject({
      ok: true,
      redirect_uri: "http://127.0.0.1:1234/cb",
    });
  });

  it("takes the first entry when several are registered", () => {
    expect(
      checkCredentials(cred({ redirect_uris: ["http://localhost/a", "http://localhost/b"] }), P),
    ).toMatchObject({ redirect_uri: "http://localhost/a" });
  });

  it("refuses a client with no redirect_uris and names the client type to create", () => {
    const r = checkCredentials(cred({}), P);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/Desktop app/);
  });

  it("refuses an empty redirect_uris array", () => {
    const r = checkCredentials(cred({ redirect_uris: [] }), P);
    expect(r.ok).toBe(false);
  });

  it("refuses a redirect that does not come back to this machine", () => {
    const r = checkCredentials(cred({ redirect_uris: ["https://example.com/cb"] }), P);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/loopback/i);
  });

  it("refuses a redirect that is not a URL at all", () => {
    const r = checkCredentials(cred({ redirect_uris: ["not a url"] }), P);
    expect(r.ok).toBe(false);
  });

  it("still reports the missing-secret case first, before the redirect check", () => {
    // Order matters for the message the user gets: a half-downloaded file should not be
    // diagnosed as a redirect problem.
    const raw = JSON.stringify({ installed: { client_id: "cid" } });
    expect((checkCredentials(raw, P) as { message: string }).message).toMatch(
      /client_id or client_secret/,
    );
  });
});
