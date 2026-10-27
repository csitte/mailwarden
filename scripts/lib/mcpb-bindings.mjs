/**
 * Pure logic behind the native-binding step in `npm run mcpb`.
 *
 * Why this exists: `@napi-rs/keyring` (the OS keystore that encrypts the token) is a native module
 * with one npm package per platform, declared as optional dependencies. `npm ci` installs only the
 * one for the machine it runs on — so a bundle built on Windows carried the Windows binary alone, and
 * on macOS or Linux the binding failed to load and every new token was stored in plaintext. Nothing
 * broke; `--auth` merely said so. A bundle is one file for every platform its manifest declares, so it
 * has to carry every binary those platforms can load.
 *
 * Where the packages come from: the lockfile, never the registry's latest. Each entry carries the
 * exact `resolved` URL and the `integrity` hash, so the build fetches what `npm ci` would fetch on that
 * platform and refuses anything that does not hash to it.
 *
 * Which ones: every keyring platform package whose `os` is a platform the manifest declares, on the
 * CPUs a current Node release ships for (x64, arm64). That leaves out FreeBSD (not a declared
 * platform), 32-bit Windows and ARMv7 (no Node 20+ runtime a desktop host would bundle) and RISC-V.
 * Both Linux libcs are kept: the binding picks glibc or musl at load time, and a musl host is
 * otherwise exactly the silent-plaintext case this step exists to prevent.
 *
 * No IO here: the caller hands in the parsed lockfile and the manifest's platform list.
 */

export const BINDING_PREFIX = "node_modules/@napi-rs/keyring-";
export const BUNDLED_CPUS = ["x64", "arm64"];

/**
 * The lockfile entries of the keyring platform packages a bundle for `platforms` must carry, sorted
 * by name. Throws when the lockfile lacks the parent package or an entry lacks what the fetch needs —
 * a bundle silently missing a binary is the failure this guards against, so a gap is never skipped.
 */
export function bindingPackages(lock, platforms) {
  const packages = lock?.packages ?? {};
  const parent = packages["node_modules/@napi-rs/keyring"];
  if (!parent) throw new Error("package-lock.json has no node_modules/@napi-rs/keyring entry");
  const selected = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith(BINDING_PREFIX)) continue;
    const os = entry.os ?? [];
    const cpu = entry.cpu ?? [];
    if (!os.some((o) => platforms.includes(o))) continue;
    if (!cpu.some((c) => BUNDLED_CPUS.includes(c))) continue;
    const name = key.slice("node_modules/".length);
    if (!entry.resolved || !entry.integrity) {
      throw new Error(`${name} in package-lock.json has no resolved URL or integrity hash`);
    }
    if (entry.version !== parent.version) {
      // The binding's loader refuses a platform package whose version differs from its own.
      throw new Error(`${name} is ${entry.version}, @napi-rs/keyring is ${parent.version}`);
    }
    selected.push({ name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity, os, cpu });
  }
  selected.sort((a, b) => a.name.localeCompare(b.name));
  return selected;
}

/**
 * The (os, cpu) pairs `platforms` × BUNDLED_CPUS that no selected package covers — empty when the
 * bundle runs everywhere its manifest says it does. Linux counts as covered once either libc is.
 */
export function uncoveredTargets(selected, platforms) {
  const missing = [];
  for (const os of platforms) {
    for (const cpu of BUNDLED_CPUS) {
      if (!selected.some((p) => p.os.includes(os) && p.cpu.includes(cpu))) missing.push(`${os}-${cpu}`);
    }
  }
  return missing;
}

/** Parse an SRI string (`sha512-<base64>`) into the hash algorithm and digest Node's crypto wants. */
export function parseIntegrity(integrity) {
  const m = /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+=*)$/.exec(integrity ?? "");
  if (!m) throw new Error(`unsupported integrity string: ${integrity}`);
  return { algorithm: m[1], digest: m[2] };
}
