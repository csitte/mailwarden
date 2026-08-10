import { CliError } from "./cli.js";
import { timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Streamable HTTP transport for remote hosting (VPS / claude.ai custom connector).
 *
 * Security posture (secure-by-default):
 * - Binds to 127.0.0.1 by default — NOT every interface — so a bare `--http`
 *   isn't reachable from the LAN. Override with MAILWARDEN_HOST for real hosting.
 * - Refuses to start unauthenticated: without MAILWARDEN_TOKEN the endpoint would
 *   hand any reachable client full mailbox control. Set the token, or explicitly
 *   opt into MAILWARDEN_ALLOW_NO_TOKEN=1 for a trusted, isolated network.
 * - Validates the Host header for a loopback bind (DNS-rebinding defense): a
 *   browser tricked into resolving an attacker domain to 127.0.0.1 still sends
 *   the attacker's Host, which the allowlist rejects.
 *
 * The pure helpers below are exported so this policy is unit-tested without
 * standing up a real server.
 */

export interface HttpConfig {
  port: number;
  host: string;
  bearer: string | undefined;
  allowNoToken: boolean;
  extraAllowedHosts: string[];
}

/**
 * Parse PORT to a valid TCP port, defaulting to 8787 when unset/blank. A
 * malformed value (`Number("abc")` → NaN) must fail fast with an actionable
 * message rather than reach `app.listen(NaN)`, which silently binds a random port.
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8787;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliError(`Invalid PORT "${raw}" — must be an integer between 1 and 65535.`);
  }
  return n;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  return {
    port: parsePort(env.PORT),
    host: env.MAILWARDEN_HOST ?? "127.0.0.1",
    bearer: env.MAILWARDEN_TOKEN || undefined,
    allowNoToken: env.MAILWARDEN_ALLOW_NO_TOKEN === "1",
    extraAllowedHosts: (env.MAILWARDEN_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Throws with an actionable message when `--http` would expose an unauthenticated endpoint. */
export function assertAuthConfigured(cfg: HttpConfig): void {
  if (!cfg.bearer && !cfg.allowNoToken) {
    throw new CliError(
      "Refusing to start --http without a bearer token — this would expose full Gmail access to any reachable client. " +
        "Set MAILWARDEN_TOKEN=<secret>, or set MAILWARDEN_ALLOW_NO_TOKEN=1 to run unauthenticated (only on a trusted, isolated network).",
    );
  }
}

/** Host:port values accepted for a loopback bind, plus any MAILWARDEN_ALLOWED_HOSTS extras. */
export function buildAllowedHosts(cfg: HttpConfig): Set<string> {
  const hosts = new Set<string>([
    `127.0.0.1:${cfg.port}`,
    `localhost:${cfg.port}`,
    `[::1]:${cfg.port}`,
  ]);
  if (!isLoopbackHost(cfg.host)) hosts.add(`${cfg.host}:${cfg.port}`);
  for (const h of cfg.extraAllowedHosts) hosts.add(h);
  return hosts;
}

/**
 * Host-header allowlist is enforced only for a loopback bind — the DNS-rebinding
 * threat model. A non-loopback bind is deliberate remote hosting where the
 * operator's proxy/infrastructure owns Host validation (and the bearer token
 * guards access), so we don't second-guess the Host there.
 */
export function hostHeaderAllowed(
  cfg: HttpConfig,
  allowed: Set<string>,
  hostHeader: string | undefined,
): boolean {
  if (!isLoopbackHost(cfg.host)) return true;
  if (!hostHeader) return true; // HTTP/1.1 requires Host; a missing one is left to the token gate
  return allowed.has(hostHeader);
}

/** Constant-time bearer comparison so the token can't be guessed byte-by-byte via timing. */
export function bearerAuthorized(bearer: string | undefined, header: string | undefined): boolean {
  if (!bearer) return true;
  const expected = Buffer.from(`Bearer ${bearer}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Stateless mode: a fresh McpServer + transport per request — a single shared
 * McpServer must NOT be connect()ed to concurrent transports, since each
 * connect() replaces the previous transport and cross-wires in-flight requests.
 *
 * Express/transport wiring (like index.ts) is covered by the manual MCP smoke
 * test, not vitest — the security *policy* it applies lives in the pure helpers
 * above, which are unit-tested.
 */
/* v8 ignore start */
export async function startHttp(makeServer: () => McpServer): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const express = (await import("express")).default;

  const cfg = readHttpConfig();
  assertAuthConfigured(cfg);
  const allowedHosts = buildAllowedHosts(cfg);

  const app = express();
  app.use(express.json({ limit: "1mb" })); // MCP requests are small; cap the body to bound abuse

  app.use((req, res, next) => {
    if (!hostHeaderAllowed(cfg, allowedHosts, req.headers.host)) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    if (!bearerAuthorized(cfg.bearer, req.headers.authorization)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: isLoopbackHost(cfg.host),
      allowedHosts: [...allowedHosts],
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(cfg.port, cfg.host, () =>
    console.error(`mailwarden MCP server (HTTP) on http://${cfg.host}:${cfg.port}/mcp`),
  );
}
/* v8 ignore stop */
