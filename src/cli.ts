/**
 * Pure argv handling for the CLI. Kept out of index.ts (which is IO/transport wiring and excluded
 * from coverage) because these are the decisions that silently route an OAuth consent into the
 * *wrong* token file when they are wrong — they need to be unit-testable, not smoke-tested by hand.
 */

/**
 * An error with a message written *for the user* (bad flag, bad env, not authorized). The CLI
 * prints these as a plain line; anything else is an internal fault and keeps its stack, because a
 * one-line `Cannot read properties of undefined` is not a usable bug report.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * What went wrong, in a form an agent can branch on. Deliberately short: every
 * code has to answer a different question ("re-authorize?", "retry?", "fix the
 * arguments?"), otherwise it is decoration.
 */
export type ToolErrorCode =
  /** The arguments are wrong — retrying the same call cannot help. */
  | "invalid_input"
  /** No usable token yet: run `mailwarden --auth`. */
  | "not_authorized"
  /** The token was there and is dead (expired/revoked): re-authorize. */
  | "needs_reauth"
  /** The token lacks a scope this operation needs: re-authorize with the tier enabled. */
  | "insufficient_scope"
  /** mailwarden itself refuses this — no send, no permanent delete, no forwarding. */
  | "forbidden_operation"
  /** Google says the thread/label/filter does not exist. */
  | "not_found"
  /** Gmail rate limit. Retrying later is the fix. */
  | "rate_limited"
  /** Gmail answered 5xx. Retrying later is the fix. */
  | "upstream_unavailable"
  /** The request never got an answer (connection reset, timeout, DNS). */
  | "network_error"
  /** Anything unclassified — a bug until proven otherwise. */
  | "internal_error";

/**
 * A `CliError` that also carries a machine-readable code, so the MCP tool layer
 * can answer with something an agent can act on instead of prose. It extends
 * `CliError` because the message is still written for a human: the CLI keeps
 * printing it as a plain line, exactly as before.
 *
 * It lives here, next to its parent, rather than beside the classifier that reads
 * it — so the modules that *throw* it (`gmail.ts`, `egress.ts`, `auth.ts`) need no
 * import of a module that in turn imports them.
 */
export class ToolError extends CliError {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Whether the debug escape hatch is on. `0`/`false`/`no`/`off`/empty all mean OFF. */
export function debugEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.MAILWARDEN_DEBUG?.trim().toLowerCase();
  return v !== undefined && !["", "0", "false", "no", "off"].includes(v);
}

/** Which run mode the argv selects. Order matters: the doctor is checked before everything else. */
export type CliMode = "check" | "auth" | "sweep" | "http" | "serve";

/** The run mode for these args, mirroring index.ts's dispatch order. */
export function resolveMode(args: string[]): CliMode {
  if (args.includes("--check") || args.includes("--doctor")) return "check";
  if (args.includes("--auth")) return "auth";
  if (args.includes("--sweep")) return "sweep";
  if (args.includes("--http")) return "http";
  return "serve";
}

/**
 * The raw value of `--account <name>` / `--account=<name>`, or undefined if not given.
 *
 * Deliberately NOT validated here: a malformed name must still reach `--check`, whose job is to
 * *report* that misconfiguration rather than be pre-empted by a throw. Validation happens in
 * `sanitizeAccount`/`activeAccount` for the modes that should fail fast.
 *
 * A value-less `--account` (last argument, or immediately followed by another flag) DOES throw:
 * treating it as "absent" would silently fall back to the default account and let `--auth`
 * overwrite the default token — the exact accident this flag exists to prevent.
 */
export function readAccountArg(args: string[]): string | undefined {
  const missing = () => {
    throw new CliError("`--account` needs a value, e.g. `--account work`.");
  };
  // Two accounts in one command is a contradiction, not a preference: silently taking either
  // would authorize a mailbox the user did not mean to pick. Refuse instead of guessing.
  const given = args.filter((a) => a === "--account" || a.startsWith("--account="));
  if (given.length > 1) {
    throw new CliError("`--account` was given more than once — specify exactly one account.");
  }
  const i = args.indexOf("--account");
  if (i !== -1) {
    const v = args[i + 1];
    // An EMPTY value must throw too, not read as "absent": `--account "$ACCT"` with an unset
    // variable would otherwise resolve to the default account and let --auth overwrite the
    // default token — the very accident this flag prevents.
    // `--account --http` is the next FLAG, i.e. the value was forgotten…
    if (v === undefined || v.trim() === "" || v.startsWith("--")) missing();
    // …whereas `--account -work` is a value that is present but malformed. Saying "needs a
    // value" there would send the user to add one they already typed.
    if (v.startsWith("-")) {
      throw new CliError(`Invalid account name "${v}" — it must not start with "-".`);
    }
    return v;
  }
  const eq = args.find((a) => a.startsWith("--account="));
  if (eq !== undefined) {
    const v = eq.slice("--account=".length);
    if (v.trim() === "") missing(); // `--account=` alone
    return v;
  }
  return undefined;
}

/**
 * Where the project lives. Kept next to the line that prints it, and held against package.json's
 * `bugs.url` by a test, because a link that has quietly rotted is worse than no link: it sends a
 * user who already has a problem to a 404.
 */
export const REPO_URL = "https://github.com/csitte/mailwarden";

/**
 * The one line that names where the docs and the issue tracker are.
 *
 * mailwarden is installed far more often than it is visited — `npx` puts it to work without anyone
 * ever seeing the repository, and until now nothing in a run said where to look when something was
 * unclear or wrong. This is that missing signpost, not a promotion: it appears only at the end of
 * the two modes a human sits and watches (`--auth`, `--check`), once, and never in server mode,
 * where stderr belongs to the host's log and a link would be noise in a machine's transcript.
 *
 * It points at the repository rather than the product page on purpose. The README ships with the
 * package and is corrected in the same commit as the code; a mirrored page can lag behind a fix by
 * days, and the one thing a signpost must not do is lead somewhere out of date.
 *
 * `problem` adds the issue tracker. Someone whose setup just failed is the one person who both
 * needs it and has something worth reporting — offering it after a clean run instead would be
 * asking for noise from the people with nothing to say.
 */
export function helpFooter(state: "ok" | "problem"): string {
  const docs = `Docs: ${REPO_URL}#readme`;
  return state === "problem" ? `${docs} — report a problem: ${REPO_URL}/issues` : docs;
}

/**
 * A bare positional argument, if any — i.e. a token that is neither a flag nor the value of
 * `--account`. `mailwarden --auth work` is almost certainly a forgotten `--account`, and silently
 * ignoring it would authorize (and overwrite) the DEFAULT account while the user believes they
 * created a named one. Returns the offending argument so the caller can name it.
 */
export function findStrayPositional(args: string[]): string | undefined {
  return args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--account");
}
