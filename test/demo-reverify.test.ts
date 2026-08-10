import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
const demo = path.join(root, "scripts", "demo-reverify.mjs");
const built = path.join(root, "dist", "gmail.js");

/**
 * The README and SECURITY.md present this demo as the runnable proof of the re-verification
 * differentiator, and its own header calls it "a living check, not just a printout". That is only
 * true if something actually runs it — so the test suite does.
 *
 * The demo asserts its own outcome and exits non-zero on regression; execFile rejects on a
 * non-zero exit, so a broken differentiator fails this test.
 *
 * It imports from dist/, so it needs a build. `npm run prepublishOnly` builds before testing and
 * CI builds before the test step; for a bare `vitest run` on a tree that was never built we skip
 * instead of reporting a false failure.
 */
describe.skipIf(!existsSync(built))("re-verification demo", () => {
  it("exits 0 and drops the loose index's read false positive", async () => {
    const { stdout } = await run(process.execPath, [demo], { cwd: root });
    expect(stdout).toMatch(/Dropped as false positives: b/);
    expect(stdout).toMatch(/dropped the read thread the raw index wrongly returned/);
  }, 20_000);
});
