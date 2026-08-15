/**
 * Tool tiers + the OAuth scopes each needs. A neutral module (no imports from
 * tools/auth) so both can depend on it without a cycle.
 */
import { CliError } from "./cli.js";

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
      throw new CliError(
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
 * The server-level `instructions` a client sees at initialize time. Clients that defer tool
 * definitions (Claude Code's tool search loads only tool NAMES plus these instructions at session
 * start) decide from this text WHEN to look for our tools at all — so it names the jobs the
 * enabled tiers cover, in plain user language, and states the two invariants an agent must know
 * before it acts (nothing sends, nothing hard-deletes). Kept well under the 2 KB truncation
 * point, most important first. Tier-aware: a read-only deployment must not advertise snooze.
 */
export function serverInstructions(tiers: Set<ToolTier>): string {
  const jobs: string[] = [];
  if (tiers.has("read")) {
    jobs.push(
      "search and read mail (search results are re-verified against live labels, so `is:unread`-style " +
        "predicates are trustworthy), list labels, get a triage digest of a mailbox slice, and list " +
        "subscriptions/newsletters by sender with their opt-out options",
    );
  }
  if (tiers.has("manage")) {
    jobs.push(
      "archive, label, mark read/unread, trash/untrash (recoverable), bulk-change everything matching " +
        "a query, snooze a thread to a date/time or preset and sweep due snoozes back into the inbox, " +
        "unsubscribe from newsletters (one-click, RFC 8058), and download attachments",
    );
  }
  if (tiers.has("filters")) {
    jobs.push("list, create and delete server-side Gmail filters (auto-triage rules; label actions only)");
  }
  const triggers = ["asks about their Gmail inbox, specific emails or newsletters"];
  if (tiers.has("manage")) triggers.push("wants to organize, defer (snooze) or clean up mail");
  if (tiers.has("filters")) triggers.push("wants Gmail to auto-triage incoming mail with rules");
  const scope =
    jobs.length === 0
      ? "No tools are enabled in this deployment."
      : `Use these tools whenever the user ${triggers.join(", or ")}. They can: ${jobs.join("; ")}.`;
  const which = tiers.has("read") ? " (call get_profile to confirm which)" : "";
  return (
    `mailwarden — live Gmail tools for the one account this server is connected to${which}. ` +
    scope +
    " By design there are NO compose/reply/forward/send tools and no permanent delete (trash only); do " +
    "not look for them. Every call reads the live mailbox — nothing is cached or synced."
  );
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
