import { describe, it, expect } from "vitest";
import {
  readHttpConfig,
  parsePort,
  isLoopbackHost,
  assertAuthConfigured,
  buildAllowedHosts,
  hostHeaderAllowed,
  bearerAuthorized,
  downloadFenceWarning,
  type HttpConfig,
} from "../src/http.js";

const cfg = (over: Partial<HttpConfig> = {}): HttpConfig => ({
  port: 8787,
  host: "127.0.0.1",
  bearer: undefined,
  allowNoToken: false,
  extraAllowedHosts: [],
  ...over,
});

describe("readHttpConfig", () => {
  it("defaults to loopback + no token, reading overrides from env", () => {
    expect(readHttpConfig({})).toEqual({
      port: 8787,
      host: "127.0.0.1",
      bearer: undefined,
      allowNoToken: false,
      extraAllowedHosts: [],
    });
    expect(
      readHttpConfig({
        PORT: "9000",
        MAILWARDEN_HOST: "0.0.0.0",
        MAILWARDEN_TOKEN: "secret",
        MAILWARDEN_ALLOW_NO_TOKEN: "1",
        MAILWARDEN_ALLOWED_HOSTS: "a.example:9000, b.example:9000 ,",
      }),
    ).toEqual({
      port: 9000,
      host: "0.0.0.0",
      bearer: "secret",
      allowNoToken: true,
      extraAllowedHosts: ["a.example:9000", "b.example:9000"],
    });
  });

  it("treats an empty MAILWARDEN_TOKEN as no token", () => {
    expect(readHttpConfig({ MAILWARDEN_TOKEN: "" }).bearer).toBeUndefined();
  });

  it("rejects a malformed PORT instead of binding a random port (NaN)", () => {
    expect(() => readHttpConfig({ PORT: "not-a-port" })).toThrow(/Invalid PORT/);
  });
});

describe("parsePort", () => {
  it("defaults to 8787 when unset or blank", () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort("")).toBe(8787);
    expect(parsePort("   ")).toBe(8787);
  });

  it("parses a valid port", () => {
    expect(parsePort("9000")).toBe(9000);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-integers and out-of-range values (would become NaN or an invalid bind)", () => {
    for (const bad of ["abc", "80.5", "0", "-1", "65536", "99999"]) {
      expect(() => parsePort(bad)).toThrow(/Invalid PORT/);
    }
  });
});

describe("assertAuthConfigured", () => {
  it("refuses to start with neither a token nor the explicit opt-out", () => {
    expect(() => assertAuthConfigured(cfg())).toThrow(/Refusing to start --http without a bearer token/);
  });
  it("allows a token", () => {
    expect(() => assertAuthConfigured(cfg({ bearer: "s" }))).not.toThrow();
  });
  it("allows the explicit unauthenticated opt-in", () => {
    expect(() => assertAuthConfigured(cfg({ allowNoToken: true }))).not.toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("recognises the loopback spellings", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("buildAllowedHosts", () => {
  it("lists the loopback spellings with the port", () => {
    expect(buildAllowedHosts(cfg())).toEqual(
      new Set(["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]),
    );
  });
  it("adds a non-loopback bind host and any configured extras", () => {
    const hosts = buildAllowedHosts(cfg({ host: "mail.example", extraAllowedHosts: ["proxy:443"] }));
    expect(hosts.has("mail.example:8787")).toBe(true);
    expect(hosts.has("proxy:443")).toBe(true);
  });
});

describe("hostHeaderAllowed — DNS-rebinding defense", () => {
  const c = cfg();
  const allowed = buildAllowedHosts(c);

  it("accepts a loopback Host header", () => {
    expect(hostHeaderAllowed(c, allowed, "127.0.0.1:8787")).toBe(true);
    expect(hostHeaderAllowed(c, allowed, "localhost:8787")).toBe(true);
  });
  it("rejects an attacker Host header on a loopback bind (rebinding)", () => {
    expect(hostHeaderAllowed(c, allowed, "attacker.example")).toBe(false);
    expect(hostHeaderAllowed(c, allowed, "127.0.0.1:9999")).toBe(false); // wrong port
  });
  it("passes a missing Host through to the token gate", () => {
    expect(hostHeaderAllowed(c, allowed, undefined)).toBe(true);
  });
  it("does not police Host on a non-loopback (deliberate remote) bind", () => {
    const remote = cfg({ host: "0.0.0.0" });
    expect(hostHeaderAllowed(remote, buildAllowedHosts(remote), "anything.example")).toBe(true);
  });
});

describe("bearerAuthorized", () => {
  it("allows everything when no token is configured", () => {
    expect(bearerAuthorized(undefined, undefined)).toBe(true);
    expect(bearerAuthorized(undefined, "Bearer whatever")).toBe(true);
  });
  it("requires an exact Bearer match when a token is set", () => {
    expect(bearerAuthorized("s3cret", "Bearer s3cret")).toBe(true);
    expect(bearerAuthorized("s3cret", "Bearer wrong")).toBe(false);
    expect(bearerAuthorized("s3cret", "s3cret")).toBe(false); // missing "Bearer " prefix
    expect(bearerAuthorized("s3cret", undefined)).toBe(false);
  });
});


describe("downloadFenceWarning — an unfenced download_attachment over HTTP", () => {
  it("warns when the fence is unset and the download tool is registered", () => {
    // src/gmail.ts names this exact exposure in a comment; until now nothing acted on it.
    const w = downloadFenceWarning({});
    expect(w).toMatch(/MAILWARDEN_DOWNLOAD_DIR is not set/);
    expect(w).toMatch(/any authorized client can write to any path/);
    // A warning is only useful if it says what to do about it.
    expect(w).toMatch(/MAILWARDEN_TOOLS=read/);
  });

  it("says nothing once the fence is configured", () => {
    expect(downloadFenceWarning({ MAILWARDEN_DOWNLOAD_DIR: "/srv/downloads" })).toBeNull();
  });

  it("says nothing for a read-only deployment — it has no download_attachment", () => {
    // download_attachment is registered in the manage tier. Warning about a tool the
    // deployment never exposes would train the operator to ignore the warning.
    expect(downloadFenceWarning({ MAILWARDEN_TOOLS: "read" })).toBeNull();
    expect(downloadFenceWarning({ MAILWARDEN_READONLY: "1" })).toBeNull();
  });

  it("warns for any tier selection that includes manage", () => {
    expect(downloadFenceWarning({ MAILWARDEN_TOOLS: "read,manage" })).not.toBeNull();
    expect(downloadFenceWarning({ MAILWARDEN_TOOLS: "manage" })).not.toBeNull();
    expect(downloadFenceWarning({ MAILWARDEN_TOOLS: "read,filters" })).toBeNull();
  });

  it("prefers the fence over the tier check — a fenced manage deployment is fine", () => {
    expect(
      downloadFenceWarning({ MAILWARDEN_TOOLS: "manage", MAILWARDEN_DOWNLOAD_DIR: "/d" }),
    ).toBeNull();
  });

  it("propagates an invalid tier setting rather than swallowing it", () => {
    // Reading MAILWARDEN_TOOLS here must not become a second, silent parser: an unusable
    // value has to fail at startup the way it always did, not turn into "no warning".
    expect(() => downloadFenceWarning({ MAILWARDEN_TOOLS: "nonsense" })).toThrow();
  });
});
