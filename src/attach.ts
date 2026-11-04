/**
 * Files for draft attachments — the one place mailwarden reads a file from the local disk on a
 * caller's say-so, and so the one place a prompt-injected instruction could reach for one.
 *
 * The boundary is a directory the operator names in MAILWARDEN_ATTACH_DIR and fills with what may
 * leave. Without it there is nothing to read: unlike MAILWARDEN_DOWNLOAD_DIR, which only narrows
 * where a download may land, an unset MAILWARDEN_ATTACH_DIR switches file attachments off. A path
 * is checked against the directory as configured and as resolved, and the file itself again after
 * `realpath`, so neither `..` nor a symlink inside the directory leads out of it.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, ToolError } from "./cli.js";
import { MAX_ATTACHMENT_BYTES, formatBytes } from "./draft.js";

/**
 * Why a value cannot be the attachment directory, or null. Pure. A filesystem root and the home
 * directory itself are refused: either would put every file the user owns behind one path, which
 * is the opposite of a folder the user fills with what may leave. A folder below home is fine.
 */
export function attachDirProblem(dir: string, home: string): string | null {
  if (!path.isAbsolute(dir)) return "it is not an absolute path";
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return "it is the root of a drive or filesystem";
  const same = (a: string, b: string) =>
    process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (home && same(resolved, path.resolve(home))) return "it is the home directory itself";
  return null;
}

/** MAILWARDEN_ATTACH_DIR as configured, checked at startup; undefined when unset. */
export function resolveAttachDir(env: NodeJS.ProcessEnv, home = os.homedir()): string | undefined {
  const raw = env.MAILWARDEN_ATTACH_DIR?.trim();
  if (!raw) return undefined;
  const problem = attachDirProblem(raw, home);
  if (problem) {
    throw new CliError(
      `MAILWARDEN_ATTACH_DIR is not usable (${raw}): ${problem}. Point it at a folder of its own that holds only what may be attached.`,
    );
  }
  return path.resolve(raw);
}

/**
 * Read one file from the attachment directory: a relative `given` resolves inside it, an absolute
 * one must lie inside it. Only a regular file, only up to the size limit, and only after its real
 * path is known to be inside the directory's real path.
 */
export async function readAttachmentFile(
  root: string | undefined,
  given: string,
): Promise<{ filename: string; data: Buffer }> {
  if (!root) {
    throw new ToolError(
      "invalid_input",
      "Attachments from files are off: the operator has not set MAILWARDEN_ATTACH_DIR, the one folder mailwarden may attach files from. Nothing was written.",
    );
  }
  const outside = () =>
    new ToolError("forbidden_operation", `"${given}" is outside MAILWARDEN_ATTACH_DIR (${root}); nothing was written.`);
  const escapes = (rel: string) => rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
  let fence: string;
  try {
    fence = await fs.realpath(root);
  } catch {
    throw new ToolError("not_found", `MAILWARDEN_ATTACH_DIR (${root}) does not exist; nothing was written.`);
  }
  // Lexically first, against both spellings of the root, so `..` never reaches the filesystem.
  let rel = path.relative(root, path.resolve(root, given));
  if (escapes(rel)) rel = path.relative(fence, path.resolve(fence, given));
  if (escapes(rel)) throw outside();
  let real: string;
  try {
    real = await fs.realpath(path.join(fence, rel));
  } catch {
    throw new ToolError("not_found", `There is no file "${given}" in MAILWARDEN_ATTACH_DIR; nothing was written.`);
  }
  // …and again after every symlink is resolved: a link inside the folder may point anywhere.
  if (escapes(path.relative(fence, real))) throw outside();
  const handle = await fs.open(real, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ToolError("invalid_input", `"${given}" is not a regular file; nothing was written.`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new ToolError(
        "invalid_input",
        `"${given}" is ${formatBytes(stat.size)}, more than Gmail's limit of ${formatBytes(MAX_ATTACHMENT_BYTES)}; nothing was written.`,
      );
    }
    // Read through the handle that was checked, so the file cannot be swapped in between.
    return { filename: path.basename(path.join(fence, rel)), data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
