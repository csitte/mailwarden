/**
 * The Mark of the Web on a saved attachment, so opening it warns as a browser download does.
 *
 * Windows records where a file came from in an NTFS alternate data stream, `Zone.Identifier`;
 * `ZoneId=3` is the Internet zone. Explorer, SmartScreen and Office read it: an executable asks
 * before it runs, a macro document opens in Protected View. A file written by a program carries no
 * such stream, so an attachment saved by `download_attachment` used to open like a file the user
 * made themselves — the one difference between it and the same attachment saved from Gmail in a
 * browser. `a-bonus/google-docs-mcp` marks its downloads the same way since 17 November 2026.
 *
 * Windows only. macOS keeps the equivalent in the `com.apple.quarantine` extended attribute, which
 * Node cannot write without a native module or a call to the `xattr` program; neither is taken on
 * for this, so a file saved on macOS or Linux is unmarked, and the answer says so by leaving the
 * field out rather than reporting `false`.
 */

import fs from "node:fs/promises";

/** The stream's content, CRLF as Windows writes it; built from code points so no tool rewrites an escape. */
const CRLF = String.fromCharCode(13, 10);
export const ZONE_IDENTIFIER = ["[ZoneTransfer]", "ZoneId=3", ""].join(CRLF);

/**
 * Mark `file` as downloaded from the Internet. `true` when the mark was written, `false` when it
 * could not be — a file system without alternate data streams (FAT, exFAT, some network shares), or
 * the file already gone — and `undefined` on a platform that has no such mark here. Never throws: the
 * file is saved either way, and a missing mark must not turn a saved attachment into a failed call.
 *
 * The file is looked for first: writing a stream to a path whose file a virus scanner has just
 * removed would create an empty file there, marked (grok-mailwarden, 0.33.0 round, L7).
 */
export async function markAsDownloaded(
  file: string,
  platform: NodeJS.Platform = process.platform,
  write: (target: string, data: string) => Promise<void> = async (target, data) => {
    await fs.stat(file);
    await fs.writeFile(target, data);
  },
): Promise<boolean | undefined> {
  if (platform !== "win32") return undefined;
  try {
    await write(`${file}:Zone.Identifier`, ZONE_IDENTIFIER);
    return true;
  } catch {
    return false;
  }
}
