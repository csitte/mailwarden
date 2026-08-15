/**
 * Triage signals — per-thread flags an agent can act on WITHOUT opening the mail,
 * derived from headers and MIME structure the `search` fetch already has in hand
 * (format=full), so they cost no extra API call.
 *
 * Deliberately conservative: every signal is a documented header convention or MIME
 * fact, never a guess from subject/body wording. A missing signal means "nothing
 * declared", not "definitely personal mail". Pure, so a header corpus can hold it.
 */

export type Signal = "newsletter" | "automated" | "calendar" | "replyToMismatch";

/** Fixed order for stable output — a thread's signals are always listed in this order. */
export const ALL_SIGNALS: readonly Signal[] = ["newsletter", "automated", "calendar", "replyToMismatch"];

export interface SignalInput {
  /** Raw headers of the message (name/value, any casing, as Gmail returns them). */
  headers: { name?: string | null; value?: string | null }[];
  /** Every MIME part's type + filename, flattened (root part included). */
  parts: { mimeType?: string | null; filename?: string | null }[];
}

/**
 * Local-parts that by convention mark a sender as a machine, not a person. Matched
 * on the local-part only (before `@`) and only in these spellings — a person named
 * "Noreen Reply" must not be flagged, so no substring matching.
 */
const MACHINE_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|notifications?|alerts?|bounces?)$/i;

function header(input: SignalInput, name: string): string | undefined {
  const n = name.toLowerCase();
  const h = input.headers.find((x) => (x.name ?? "").toLowerCase() === n);
  return h?.value ?? undefined;
}

/** Lowercased address out of a From/Reply-To value; "" when none is recognisable. */
export function addressOf(value: string | undefined): string {
  if (!value) return "";
  const m = /<([^>]+)>/.exec(value);
  const raw = (m ? m[1] : value).trim().toLowerCase();
  // A bare display name with no @ is not an address.
  return raw.includes("@") ? raw : "";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1);
}

/**
 * The signals a message declares. See the module comment for what each one means:
 *
 * - `newsletter` — mailing-list / bulk machinery: `List-Id`, `List-Unsubscribe`, or
 *   `Precedence: bulk|list`. (RFC 2919 / 2369; Precedence is the de-facto convention.)
 * - `automated` — the sender says a machine wrote it: `Auto-Submitted` other than `no`
 *   (RFC 3834), `Precedence: auto_reply`, an `X-Auto-Response-Suppress` header, or a
 *   From local-part in the no-reply / mailer-daemon family.
 * - `calendar` — a `text/calendar` MIME part or an `.ics` attachment: an invitation,
 *   update or reply the user may need to answer.
 * - `replyToMismatch` — `Reply-To` names a *different domain* than `From`. Same-domain
 *   differences (`hello@` vs `support@`) are routine and not flagged. Common in phishing
 *   and in some legitimate marketing; a reason to look, not a verdict.
 */
export function deriveSignals(input: SignalInput): Signal[] {
  const out = new Set<Signal>();

  const precedence = (header(input, "Precedence") ?? "").trim().toLowerCase();
  if (
    header(input, "List-Id") !== undefined ||
    header(input, "List-Unsubscribe") !== undefined ||
    precedence === "bulk" ||
    precedence === "list"
  ) {
    out.add("newsletter");
  }

  const from = addressOf(header(input, "From"));
  const autoSubmitted = (header(input, "Auto-Submitted") ?? "").trim().toLowerCase();
  const localPart = from.slice(0, from.lastIndexOf("@"));
  if (
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    precedence === "auto_reply" ||
    header(input, "X-Auto-Response-Suppress") !== undefined ||
    MACHINE_LOCAL_PARTS.test(localPart)
  ) {
    out.add("automated");
  }

  if (
    input.parts.some(
      (p) =>
        (p.mimeType ?? "").toLowerCase().startsWith("text/calendar") ||
        /\.ics$/i.test(p.filename ?? ""),
    )
  ) {
    out.add("calendar");
  }

  const replyTo = addressOf(header(input, "Reply-To"));
  if (from && replyTo && domainOf(replyTo) !== domainOf(from)) {
    out.add("replyToMismatch");
  }

  return ALL_SIGNALS.filter((s) => out.has(s));
}
