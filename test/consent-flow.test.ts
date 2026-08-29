import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `runConsentFlow` — the one function in consent.ts that opens a socket, and until now the one
 * with no test at all. The pure helpers around it are covered thoroughly, which made the module
 * look well tested while its central security promise had nothing behind it:
 *
 *   "The callback server binds to 127.0.0.1, not to every interface. local-auth called
 *    server.listen(port) with no host, so for the seconds the consent screen was open, any host
 *    on the LAN could reach the callback endpoint and hand it a code."
 *
 * That sentence is why `@google-cloud/local-auth` was replaced. A promise that motivated
 * replacing a dependency deserves more than a comment, so the bind address, the CSRF state and
 * the flow's refusal to end on stray traffic are asserted here against a real socket.
 *
 * The Google half is faked: OAuth2Client is mocked so no token is ever exchanged with anyone,
 * and the browser is injected via `opts.open`.
 */

const authUrls: string[] = [];
const tokenCalls: Array<{ code: string; redirect_uri: string }> = [];
let tokenResult: () => Promise<{ tokens: unknown }> = async () => ({
  tokens: { refresh_token: "r", access_token: "a" },
});

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    generateAuthUrl(o: Record<string, string>) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [k, v] of Object.entries(o)) u.searchParams.set(k, String(v));
      authUrls.push(u.toString());
      return u.toString();
    }
    getToken(o: { code: string; redirect_uri: string }) {
      tokenCalls.push(o);
      return tokenResult();
    }
  },
}));

const { runConsentFlow } = await import("../src/consent.js");

const originalCreate = http.createServer;

/**
 * Records what the flow's server was told to listen on, without preventing it from listening:
 * the real server is still created and still serves, only its `listen` arguments are captured.
 * Asserting the argument is the only way to see the bind address — a server that came up on
 * 0.0.0.0 would answer every request in this file exactly as one on 127.0.0.1 does.
 */
function watchListen() {
  const seen: Array<{ port: number; host: unknown }> = [];
  vi.spyOn(http, "createServer").mockImplementation(((handler: never) => {
    const server = originalCreate(handler);
    const listen = server.listen.bind(server);
    server.listen = ((...args: unknown[]) => {
      seen.push({ port: args[0] as number, host: args[1] });
      return listen(...(args as Parameters<typeof listen>));
    }) as typeof server.listen;
    return server;
  }) as never);
  return { seen };
}

const base = {
  clientId: "id",
  clientSecret: "secret",
  registeredRedirect: "http://127.0.0.1:3000/oauth2callback",
  kind: "installed" as const,
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

/** Pull the state and the live port out of the URL the flow tried to open. */
function stateAndPort(url: string) {
  const u = new URL(url);
  const redirect = new URL(u.searchParams.get("redirect_uri")!);
  return { state: u.searchParams.get("state")!, port: Number(redirect.port), path: redirect.pathname };
}

afterEach(() => {
  vi.restoreAllMocks();
  authUrls.length = 0;
  tokenCalls.length = 0;
  tokenResult = async () => ({ tokens: { refresh_token: "r", access_token: "a" } });
});

describe("runConsentFlow — the loopback callback server", () => {
  it("binds to 127.0.0.1, never to every interface", async () => {
    // The promise that justified replacing @google-cloud/local-auth. Asserting the argument is
    // the point: passing no host, or "0.0.0.0", would open the callback to the whole LAN for as
    // long as the consent screen is up, and nothing else in the suite would notice.
    const { seen } = watchListen();
    const flow = runConsentFlow({ ...base, timeoutMs: 300, open: () => {} });
    await expect(flow).rejects.toThrow(/Timed out/);

    expect(seen).toHaveLength(1);
    expect(seen[0].host).toBe("127.0.0.1");
  });

  it("asks the OS for an ephemeral port for a desktop client", async () => {
    const { seen } = watchListen();
    await expect(runConsentFlow({ ...base, timeoutMs: 300, open: () => {} })).rejects.toThrow();
    expect(seen[0].port).toBe(0);
  });

  it("completes when the callback carries the state it issued", async () => {
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));

    const { state, port, path } = stateAndPort(opened);
    const res = await fetch(`http://127.0.0.1:${port}${path}?code=the-code&state=${state}`);
    expect(res.status).toBe(200);

    await expect(flow).resolves.toMatchObject({ refresh_token: "r" });
    // The code is exchanged against the same redirect_uri that was sent to Google, or Google
    // rejects the exchange.
    expect(tokenCalls).toEqual([{ code: "the-code", redirect_uri: `http://127.0.0.1:${port}${path}` }]);
  });

  it("issues a fresh, high-entropy state per run and sends it to Google", async () => {
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      let opened = "";
      const flow = runConsentFlow({ ...base, timeoutMs: 300, open: (u) => (opened = u) });
      await vi.waitFor(() => expect(opened).not.toBe(""));
      states.push(stateAndPort(opened).state);
      await expect(flow).rejects.toThrow();
    }
    expect(states[0]).not.toBe(states[1]);
    // 32 random bytes as base64url — long enough that guessing it is not a strategy.
    expect(states[0].length).toBeGreaterThanOrEqual(43);
  });

  it("rejects a callback with a foreign state, and exchanges nothing", async () => {
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));

    const { port, path } = stateAndPort(opened);
    // Attach the rejection handler BEFORE triggering it: the flow settles while `fetch` is
    // still awaited, and an unhandled rejection in that window is reported even though the
    // assertion below passes.
    const settled = expect(flow).rejects.toThrow(/wrong state parameter/);
    const res = await fetch(`http://127.0.0.1:${port}${path}?code=attacker&state=not-the-state`);
    expect(res.status).toBe(400);
    await settled;
    expect(tokenCalls).toEqual([]); // the attacker's code never reached Google
  });

  it("survives stray traffic while the consent is still in flight", async () => {
    // A browser prefetch or a port scan must not kill a consent the user is still completing.
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const { state, port, path } = stateAndPort(opened);

    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404);

    // The real callback still lands afterwards.
    await fetch(`http://127.0.0.1:${port}${path}?code=late&state=${state}`);
    await expect(flow).resolves.toBeTruthy();
  });

  it("ends the flow when Google reports the user declined", async () => {
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const { port, path } = stateAndPort(opened);

    const settled = expect(flow).rejects.toThrow(/declined at the consent screen/);
    await fetch(`http://127.0.0.1:${port}${path}?error=access_denied`);
    await settled;
  });

  it("surfaces a failed token exchange instead of resolving", async () => {
    tokenResult = async () => {
      throw new Error("invalid_grant");
    };
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const { state, port, path } = stateAndPort(opened);

    const settled = expect(flow).rejects.toThrow(/invalid_grant/);
    await fetch(`http://127.0.0.1:${port}${path}?code=c&state=${state}`);
    await settled;
  });

  it("frees the port once it is done, so a second run can start", async () => {
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 5000, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const { state, port, path } = stateAndPort(opened);
    await fetch(`http://127.0.0.1:${port}${path}?code=c&state=${state}`);
    await flow;

    // Binding the same port again must succeed — a leaked listener would make this throw.
    await new Promise<void>((resolve, reject) => {
      const probe = http.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        expect((probe.address() as AddressInfo).port).toBe(port);
        probe.close(() => resolve());
      });
    });
  });

  it("requests offline access and forces the consent screen", async () => {
    // Without prompt=consent Google returns a refresh token only on the very first
    // authorization, so a re-run after a stale token would hand back credentials that cannot
    // be refreshed — and the failure would only show up much later, on the first API call.
    let opened = "";
    const flow = runConsentFlow({ ...base, timeoutMs: 300, open: (u) => (opened = u) });
    await vi.waitFor(() => expect(opened).not.toBe(""));
    await expect(flow).rejects.toThrow();

    const u = new URL(opened);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});
