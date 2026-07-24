import os from "node:os";
import path from "node:path";

// Point mailwarden's config dir at a throwaway path for the whole test run so
// no test can ever fall back to the developer's real ~/.mailwarden token —
// which would make auth.ts's "not authorized" tests pass locally but fail on a
// dev machine that has real credentials (or vice-versa) if an env stub is lost.
// Tests that need specific auth state still override MAILWARDEN_DIR to their own
// temp dir; vi.unstubAllEnvs() then restores it to this empty default, never the
// real home. The path is intentionally not created (no token.json → unauthorized).
// Only MAILWARDEN_DIR is set — CRED_PATH then falls back to <dir>/credentials.json,
// which the interactive auth tests rely on pointing inside their own temp dir.
process.env.MAILWARDEN_DIR = path.join(os.tmpdir(), "mailwarden-tests-empty-home");
