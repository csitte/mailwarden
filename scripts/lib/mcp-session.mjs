/**
 * Drive a built mailwarden CLI through one MCP session over stdio and return what it reported.
 * Shared by the package smoke test and the MCPB build — both need to prove that an ARTIFACT
 * (not the working tree) boots and lists its tools.
 *
 * Waits for the response with the matching id rather than sleeping a fixed interval: a slow CI
 * runner would otherwise read as a broken handshake. Kills the child either way — the server is
 * long-lived by design and would keep the caller alive.
 *
 * @param {string} cliPath  path to the built dist/index.js
 * @param {NodeJS.ProcessEnv} env  extra environment (merged over process.env)
 * @returns {Promise<{serverInfo: any, tools: Array<{name: string, description?: string}>, stderr: string}>}
 */
import { spawn } from "node:child_process";

export function mcpSession(cliPath, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    const pending = new Map();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP handshake timed out after ${timeoutMs}ms. stderr: ${stderr.trim()}`));
    }, timeoutMs);

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const request = (id, method, params) =>
      new Promise((res) => {
        pending.set(id, res);
        send({ jsonrpc: "2.0", id, method, params });
      });

    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      // Frames are newline-delimited JSON; a chunk may hold several or half of one.
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC frame — ignore rather than fail the run
        }
        const resolveFn = pending.get(msg.id);
        if (resolveFn) {
          pending.delete(msg.id);
          resolveFn(msg);
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mailwarden-artifact-check", version: "0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await request(2, "tools/list", {});
      clearTimeout(timer);
      child.kill();
      resolve({
        serverInfo: init.result?.serverInfo,
        tools: (tools.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        stderr,
      });
    })().catch((err) => {
      clearTimeout(timer);
      child.kill();
      reject(err);
    });
  });
}
