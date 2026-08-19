/**
 * The browser consent flow, in-house.
 *
 * This used to be `@google-cloud/local-auth`. That package is a sample helper that stopped at
 * 3.0.1 and pins `google-auth-library@^9`, which pins `gaxios@6`, which is where four `uuid`
 * advisories live — so it could not be updated, only removed. What it did is ~80 lines: run a
 * loopback HTTP server, send the user to Google, take the `code` off the redirect, exchange it.
 *
 * Two things are deliberately different from what it did:
 *
 * - **The callback server binds to 127.0.0.1**, not to every interface. local-auth called
 *   `server.listen(port)` with no host, so for the seconds the consent screen was open, any host
 *   on the LAN could reach the callback endpoint and hand it a `code`.
 * - **The request carries a `state` parameter** and the callback is rejected unless it comes back
 *   unchanged. Without it, anything that can reach the callback can complete the flow with an
 *   authorization code of its own choosing (CSRF); the check is one comparison and closes it.
 *
 * And one thing is deliberately the same: the redirect URI comes from the credentials file, with
 * only its port replaced. Google matches it against what is registered for the client, so a
 * "cleaner" URI of our own choosing would break every existing setup.
 */
import { OAuth2Client } from "google-auth-library";
import type { Credentials } from "google-auth-library";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";

/** How long to wait for the user to finish at Google before giving up. */
export const CONSENT_TIMEOUT_MS = 5 * 60_000;

export type CallbackVerdict =
  | { ok: true; code: string }
  | { ok: false; status: number; body: string; reason: string | null };

/**
 * Decide what a request to the loopback server means. Pure, so every branch is unit-tested
 * without a browser or a socket.
 *
 * `reason` is null when the request is simply not the callback (a favicon fetch, a stray probe):
 * those must not fail the flow, because the real callback may still be on its way. A non-null
 * `reason` ends the flow with that message.
 *
 * The body is fixed text in every branch — nothing from the query string is ever echoed back into
 * the page, so a crafted redirect cannot turn this into a reflected-XSS surface on localhost.
 */
export function parseCallback(
  rawUrl: string | undefined,
  expect: { path: string; state: string },
): CallbackVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl ?? "/", "http://127.0.0.1");
  } catch {
    return { ok: false, status: 400, body: "Bad request.", reason: null };
  }
  if (url.pathname !== expect.path) {
    return { ok: false, status: 404, body: "Not the mailwarden callback.", reason: null };
  }
  const q = url.searchParams;
  // A request to the right path that carries none of OAuth's parameters is not a callback at all
  // — a browser prefetch, someone opening the port out of curiosity, a health probe. Ending the
  // flow on it would let any stray request kill a consent that is still in flight. Only a request
  // that *claims* to be a callback (code/error/state) is judged, and then strictly.
  if (!q.has("code") && !q.has("error") && !q.has("state")) {
    return { ok: false, status: 404, body: "Not the mailwarden callback.", reason: null };
  }
  if (q.has("error")) {
    const err = q.get("error") || "unknown";
    return {
      ok: false,
      status: 200,
      body: "Authorization was rejected. You can close this tab and return to the terminal.",
      // Google's own words for the refusal; `access_denied` is simply "the user clicked Cancel".
      reason:
        err === "access_denied"
          ? "Authorization was declined at the consent screen."
          : `Google refused the authorization: ${err}.`,
    };
  }
  // The state check comes before the code is looked at: a callback we did not initiate must not
  // get as far as being exchanged, whatever it carries.
  const state = q.get("state");
  if (!state || !timingSafeEqualStr(state, expect.state)) {
    return {
      ok: false,
      status: 400,
      body: "This callback did not come from the request mailwarden started.",
      reason: "The consent callback carried the wrong state parameter and was rejected.",
    };
  }
  const code = q.get("code");
  if (!code) {
    return {
      ok: false,
      status: 400,
      body: "No authorization code in the callback.",
      reason: "Google's callback carried no authorization code.",
    };
  }
  return { ok: true, code };
}

/** Constant-time string compare that does not leak length through an early return. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * The redirect URI to use, given what the credentials file registered and the port we actually
 * got. Pure so the port substitution is tested directly.
 *
 * A desktop ("installed") client gets an ephemeral port: Google allows any port on the loopback
 * address for those, and a fixed one would collide with whatever else is on 3000. A web client
 * must keep the registered port, since that exact URI is what Google will match.
 */
export function resolveRedirect(
  registered: string,
  kind: "installed" | "web",
  actualPort: number,
): { url: string; path: string } {
  const u = new URL(registered);
  if (kind === "installed") u.port = String(actualPort);
  return { url: u.toString(), path: u.pathname };
}

/** The port to listen on before we know the ephemeral one: 0 = let the OS choose. */
export function listenPortFor(registered: string, kind: "installed" | "web"): number {
  if (kind === "installed") return 0;
  const port = new URL(registered).port;
  return port ? Number(port) : 80;
}

/**
 * How to hand a URL to the platform's browser.
 *
 * Windows is the interesting one. `start` is a cmd builtin, and cmd splits its command line on
 * `&` — of which an OAuth URL has one before every parameter. Passed through unescaped, the
 * browser receives everything up to the first `&` and Google refuses the truncated request with
 * "Required parameter is missing: response_type", which reads like a bug in the request we built
 * rather than in how it was opened. Caret-escaping each `&` and passing the line verbatim keeps
 * the URL intact; percent-encoding passes through untouched (verified on Windows 11, both with
 * and without matching environment variables set).
 *
 * Pure, so the escaping is a unit test rather than something only a live consent screen catches.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): { cmd: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") {
    // The empty string is `start`'s window-title argument: without it, a quoted URL would be
    // taken as the title and nothing would open.
    return { cmd: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")], verbatim: true };
  }
  if (platform === "darwin") return { cmd: "open", args: [url], verbatim: false };
  return { cmd: "xdg-open", args: [url], verbatim: false };
}

/** Open the system browser. Never through a shell, so the URL is never re-parsed as a command. */
function openBrowser(url: string): void {
  const { cmd, args, verbatim } = browserCommand(url, process.platform);
  try {
    spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    }).unref();
  } catch {
    // Headless box, no xdg-open, locked-down desktop — the URL is printed either way, so this is
    // a convenience that failed, not the flow failing.
  }
}

export interface ConsentOptions {
  clientId: string;
  clientSecret: string;
  /** The first redirect_uri from the credentials file, as registered with Google. */
  registeredRedirect: string;
  kind: "installed" | "web";
  scopes: string[];
  /** Injected in tests; defaults to the real browser and the real clock. */
  open?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Run the consent flow and return a client carrying the resulting credentials.
 *
 * `prompt: "consent"` is set on purpose. Without it Google returns a refresh token only on a
 * user's FIRST authorization, so re-running `--auth` after a token went stale would complete
 * happily and hand back credentials that cannot be refreshed — the exact dead end the caller
 * then has to report. Asking for consent every time is the right trade for a command the user
 * ran explicitly.
 */
export async function runConsentFlow(opts: ConsentOptions): Promise<Credentials> {
  const state = crypto.randomBytes(32).toString("base64url");
  const client = new OAuth2Client({ clientId: opts.clientId, clientSecret: opts.clientSecret });

  return await new Promise<Credentials>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close to new connections, then let the response flush. `unref` keeps a lingering
      // keep-alive socket from holding the process open after we are done.
      server.close();
      server.unref();
      fn();
    };

    const server = http.createServer((req, res) => {
      const verdict = parseCallback(req.url, { path: redirectPath, state });
      if (verdict.ok) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("Authorization complete. You can close this tab and return to the terminal.");
        client
          .getToken({ code: verdict.code, redirect_uri: redirectUrl })
          .then(({ tokens }) => finish(() => resolve(tokens)))
          .catch((e) => finish(() => reject(e)));
        return;
      }
      res.writeHead(verdict.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(verdict.body);
      if (verdict.reason !== null) finish(() => reject(new Error(verdict.reason!)));
    });

    server.on("error", (e) => finish(() => reject(e)));

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Timed out waiting for the browser consent to complete.")),
        ),
      opts.timeoutMs ?? CONSENT_TIMEOUT_MS,
    );

    let redirectUrl = "";
    let redirectPath = "/";

    // 127.0.0.1, not every interface: the callback is for this machine only.
    server.listen(listenPortFor(opts.registeredRedirect, opts.kind), "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const resolved = resolveRedirect(opts.registeredRedirect, opts.kind, port);
      redirectUrl = resolved.url;
      redirectPath = resolved.path;
      const authUrl = client.generateAuthUrl({
        redirect_uri: redirectUrl,
        access_type: "offline",
        prompt: "consent",
        scope: opts.scopes.join(" "),
        state,
      });
      console.error(`mailwarden: opening the consent screen. If no browser opens, visit:\n${authUrl}`);
      (opts.open ?? openBrowser)(authUrl);
    });
  });
}
