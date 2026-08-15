/**
 * Run a CLI (npm, mcpb, …) synchronously and exit the process on failure — the shape every
 * build/check script here wants: a failed step is fatal and its output is the diagnosis.
 *
 * npm is `npm.cmd` on Windows, which Node refuses to spawn directly (it is a batch file, not an
 * executable) — so that platform needs `shell: true`, and with a shell the arguments have to be
 * quoted themselves: temp and repo paths can contain spaces.
 */
import { spawnSync } from "node:child_process";

export const onWindows = process.platform === "win32";
export const npm = onWindows ? "npm.cmd" : "npm";

export function run(cmd, args, opts = {}) {
  // With a shell, pass ONE pre-quoted command string and no argv array — Node deprecates
  // (DEP0190) the array form under `shell: true` because it concatenates without escaping.
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
  const res = onWindows
    ? spawnSync(`${cmd} ${quoted}`, [], { encoding: "utf8", shell: true, ...opts })
    : spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed (exit ${res.status}):`);
    if (res.error) console.error(res.error.message);
    console.error(res.stdout ?? "");
    console.error(res.stderr ?? "");
    process.exit(1);
  }
  return res;
}
