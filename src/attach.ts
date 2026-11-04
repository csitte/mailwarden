/**
 * Files for draft attachments — the one place mailwarden reads a file from the local disk on a
 * caller's say-so, and so the one place a prompt-injected instruction could reach for one.
 *
 * The boundary is a directory the operator names in MAILWARDEN_ATTACH_DIR and fills with what may
 * leave. Without it there is nothing to read: unlike MAILWARDEN_DOWNLOAD_DIR, which only narrows
 * where a download may land, an unset MAILWARDEN_ATTACH_DIR switches file attachments off. A path
 * is checked against the directory as configured and as resolved, and the file itself again after
 * `realpath`, so neither `..` nor a symlink inside the directory leads out of it.
 *
 * Only the person fills it: `download_attachment` and `export_thread` refuse to write into it
 * (`inAttachDir`, used by gmail.ts). Otherwise the model could fetch any attachment of the mailbox
 * into the folder and attach it from there — around the rule that an attachment of a mail may only
 * come from the reply's own thread.
 */

import { constants, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, ToolError } from "./cli.js";
import { MAX_ATTACHMENT_BYTES, formatBytes } from "./draft.js";

/**
 * Whether `target` is `root` itself or lies below it. Lexical, and only as case-insensitive as
 * `path.relative`: on Windows it is, on macOS it is not, so there the real path (`realpath`) carries
 * the check.
 */
function within(root: string, target: string): boolean {
  return !escapes(path.relative(root, target)) || path.relative(root, target) === "";
}

/** A relative path that is the root itself, leaves it, or is not relative at all. By segment: `..x` is a name. */
function escapes(rel: string): boolean {
  return rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Why a value cannot be the attachment directory, or null. Pure. A filesystem root, the home
 * directory and any folder that contains it are refused: each would put every file the user owns
 * behind one path, which is the opposite of a folder the user fills with what may leave. A folder
 * below home is fine. On Windows only a drive-letter path is taken: `\\server\share`, `\\?\` and
 * `\\.\` spellings name the same places in forms the comparisons here cannot all see through
 * (`\\?\UNC\localhost\c$` parses as a share named `UNC`).
 */
export function attachDirProblem(dir: string, home: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32" && /^[\\/]{2}/.test(dir)) {
    return "it is a network, device or extended-length path; give a drive-letter path such as D:\\mail-out";
  }
  if (!path.isAbsolute(dir)) return "it is not an absolute path";
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return "it is the root of a drive or filesystem";
  if (home && within(resolved, path.resolve(home))) {
    return within(path.resolve(home), resolved) ? "it is the home directory itself" : "it contains the home directory";
  }
  return null;
}

/** `realpath` that never throws: the folder may not exist yet, and then its spelling is all there is. */
function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * MAILWARDEN_ATTACH_DIR as configured, checked at startup; undefined when unset. A
 * MAILWARDEN_DOWNLOAD_DIR that is the same folder or lies inside it is refused too: every download
 * would then be refused (see `inAttachDir`), and the setting can only have meant something else.
 */
export function resolveAttachDir(env: NodeJS.ProcessEnv, home = os.homedir()): string | undefined {
  const raw = env.MAILWARDEN_ATTACH_DIR?.trim();
  if (!raw) return undefined;
  // As written and as resolved: a junction or symlink to a drive root or to home is the same folder.
  const real = realOrNull(raw);
  const realHome = (home && realOrNull(home)) || home;
  const problem = attachDirProblem(raw, home) ?? (real ? attachDirProblem(real, realHome) : null);
  if (problem) {
    throw new CliError(
      `MAILWARDEN_ATTACH_DIR is not usable (${raw}): ${problem}. Point it at a folder of its own that holds only what may be attached.`,
    );
  }
  const download = env.MAILWARDEN_DOWNLOAD_DIR?.trim();
  if (download && within(path.resolve(raw), path.resolve(download))) {
    throw new CliError(
      `MAILWARDEN_DOWNLOAD_DIR (${download}) lies in MAILWARDEN_ATTACH_DIR (${raw}). mailwarden never writes into the ` +
        "attachment folder — only the person puts files there — so give downloads a folder of their own.",
    );
  }
  return path.resolve(raw);
}

/**
 * Whether a path mailwarden is about to write lies in MAILWARDEN_ATTACH_DIR, by the folder as
 * configured and as resolved. Checked before a directory is created and again on the real parent.
 */
export async function inAttachDir(target: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const raw = env.MAILWARDEN_ATTACH_DIR?.trim();
  if (!raw) return false;
  const roots = [path.resolve(raw)];
  try {
    roots.push(await fs.realpath(raw));
  } catch {
    // not there (yet): the configured spelling is all there is
  }
  return roots.some((r) => within(r, path.resolve(target)));
}

/**
 * Read one file from the attachment directory: a relative `given` resolves inside it, an absolute
 * one must lie inside it. Only a regular file, only up to the size limit, and only after its real
 * path is known to be inside the directory's real path.
 */
export async function readAttachmentFile(
  root: string | undefined,
  given: string,
): Promise<{ filename: string; data: Buffer; relative: string }> {
  if (!root) {
    throw new ToolError(
      "invalid_input",
      "Attachments from files are off: the operator has not set MAILWARDEN_ATTACH_DIR, the one folder mailwarden may attach files from. Nothing was written.",
    );
  }
  const outside = () =>
    new ToolError("forbidden_operation", `"${given}" is outside MAILWARDEN_ATTACH_DIR (${root}); nothing was written.`);
  let fence: string;
  try {
    fence = await fs.realpath(root);
  } catch {
    throw new ToolError("not_found", `MAILWARDEN_ATTACH_DIR (${root}) does not exist; nothing was written.`);
  }
  // Lexically first, against both spellings of the root, so `..` never reaches the filesystem.
  // A colon past the drive letter names an NTFS stream: hidden content, and a name that hides its type.
  if (process.platform === "win32" && given.replace(/^[A-Za-z]:/, "").includes(":")) {
    throw new ToolError("invalid_input", `"${given}" names a file stream, not a file; nothing was written.`);
  }
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
  // Non-blocking: a FIFO would otherwise hold the open until a writer comes, and with it one of the
  // four threads all file, DNS and crypto work of the process shares. It is refused below as not a
  // regular file. Windows has no such flag and no FIFOs a path can name.
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    // The path was checked, the handle is what is read: if the file was swapped for a link between
    // the two, the path no longer resolves inside, or no longer to the file that was opened.
    const again = await fs.realpath(real).catch(() => "");
    const atPath = again ? await fs.stat(again).catch(() => undefined) : undefined;
    if (!again || escapes(path.relative(fence, again)) || !atPath || atPath.ino !== stat.ino || atPath.dev !== stat.dev) {
      throw outside();
    }
    if (!stat.isFile()) {
      throw new ToolError("invalid_input", `"${given}" is not a regular file; nothing was written.`);
    }
    // A hard link is the same file under a second name, and that name may be anywhere: no path
    // check can tell. A file with more than one link is refused rather than guessed about. Google
    // Drive for desktop reports nlink 2 for a fresh copy while it uploads (gmail deployment,
    // 4 Nov 2026), which the message names rather than this check giving way.
    if (stat.nlink > 1) {
      throw new ToolError(
        "forbidden_operation",
        `"${given}" has more than one hard link, so it may be a file from outside MAILWARDEN_ATTACH_DIR. ` +
          "Copy the file into the folder instead. A synced drive (Google Drive for desktop) can report a second " +
          "link for a few seconds after a copy, while it uploads: then try again shortly. Nothing was written.",
      );
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new ToolError(
        "invalid_input",
        `"${given}" is ${formatBytes(stat.size)}, more than Gmail's limit of ${formatBytes(MAX_ATTACHMENT_BYTES)}; nothing was written.`,
      );
    }
    // Read through the handle that was checked, so the file cannot be swapped in between.
    // The real name, not the spelling given: `FOTO~1.JPG` or a differently cased name is not what
    // the person sees in the folder.
    const inside = path.relative(fence, again);
    return { filename: path.basename(again), data: await handle.readFile(), relative: inside.split(path.sep).join("/") };
  } finally {
    await handle.close();
  }
}
