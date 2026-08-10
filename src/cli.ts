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

/** Whether the debug escape hatch is on. `MAILWARDEN_DEBUG=0`/`false`/empty means OFF. */
export function debugEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.MAILWARDEN_DEBUG?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false" && v !== "no";
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
    if (v === undefined || v.startsWith("-") || v.trim() === "") missing();
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
 * A bare positional argument, if any — i.e. a token that is neither a flag nor the value of
 * `--account`. `mailwarden --auth work` is almost certainly a forgotten `--account`, and silently
 * ignoring it would authorize (and overwrite) the DEFAULT account while the user believes they
 * created a named one. Returns the offending argument so the caller can name it.
 */
export function findStrayPositional(args: string[]): string | undefined {
  return args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--account");
}
