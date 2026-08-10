/**
 * Tool tiers + the OAuth scopes each needs. A neutral module (no imports from
 * tools/auth) so both can depend on it without a cycle.
 */

export type ToolTier = "read" | "manage" | "filters";
export const ALL_TIERS: readonly ToolTier[] = ["read", "manage", "filters"];

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SETTINGS_BASIC = "https://www.googleapis.com/auth/gmail.settings.basic";

/**
 * Which tool tiers to advertise, from the environment:
 *   - `MAILWARDEN_TOOLS` — comma-separated subset of read/manage/filters, authoritative
 *     whenever the variable is DEFINED (a defined-but-blank value is an error, not "default",
 *     so a misconfigured `MAILWARDEN_TOOLS=${UNSET}` never silently opens the full surface);
 *   - else `MAILWARDEN_READONLY=1` — the original binary switch, = the `read` tier only;
 *   - else all tiers.
 * `read` is the usual base (search/get_thread/…); enabling only manage/filters is allowed
 * but leaves the agent without read tools. Unknown or empty values throw at startup.
 */
export function resolveEnabledTiers(env: NodeJS.ProcessEnv): Set<ToolTier> {
  const configured = env.MAILWARDEN_TOOLS;
  if (configured !== undefined) {
    const requested = configured.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = requested.filter((t) => !ALL_TIERS.includes(t as ToolTier));
    if (requested.length === 0 || unknown.length) {
      throw new Error(
        `MAILWARDEN_TOOLS is invalid (${unknown.length ? `unknown: ${unknown.join(", ")}` : "empty"}). ` +
          `Set it to a comma-separated subset of: ${ALL_TIERS.join(", ")}.`,
      );
    }
    return new Set(requested as ToolTier[]);
  }
  if (env.MAILWARDEN_READONLY === "1") return new Set<ToolTier>(["read"]);
  return new Set(ALL_TIERS);
}

/**
 * The minimal OAuth scope set covering the enabled tiers, so `--auth` requests only
 * what the deployment will use:
 *   - `manage` → `gmail.modify` (read+write); otherwise `gmail.readonly` as the base
 *     (also keeps the post-consent getProfile smoke test working for a filters-only grant);
 *   - `filters` → adds `gmail.settings.basic` (no send capability).
 * The default (all tiers) is `[gmail.modify, gmail.settings.basic]` — unchanged from before.
 */
export function authScopesForTiers(tiers: Set<ToolTier>): string[] {
  const scopes = [tiers.has("manage") ? GMAIL_MODIFY : GMAIL_READONLY];
  if (tiers.has("filters")) scopes.push(GMAIL_SETTINGS_BASIC);
  return scopes;
}

/**
 * Which of `required` a grant of `granted` does NOT cover — by *capability*, not string equality.
 * `gmail.modify` is a strict superset of `gmail.readonly`, so a token authorized for the full
 * surface satisfies a later read-only deployment. Comparing literally would flag such a healthy
 * setup as broken and push the user into re-consenting with a narrower scope.
 */
export function missingScopes(granted: string[], required: string[]): string[] {
  const effective = new Set(granted);
  if (effective.has(GMAIL_MODIFY)) effective.add(GMAIL_READONLY);
  return required.filter((s) => !effective.has(s));
}
