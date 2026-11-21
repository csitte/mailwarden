import { CliError } from "./cli.js";
import { cutText, stripHiddenChars } from "./sanitize.js";

/**
 * A human's yes before the actions that outlast the conversation, asked through MCP elicitation —
 * the client puts the question to the person at the keyboard, not to the model.
 *
 * Which actions: the ones a model cannot take back and a user would want to have seen. A filter keeps
 * acting on every future arrival with nobody in the loop; an unsubscribe is a request to someone
 * else's server that no undo reaches. A label change is not on the list — it is reversible, exactly so
 * with `undo: true`.
 *
 * Why the yes has to come from elicitation and not from the conversation: a "yes" typed in chat is
 * text the model reads, and a prompt-injected mail can produce text. An elicitation answer travels
 * from the client's own dialog to this server and never passes through the model.
 *
 * Off by default, on purpose. Many deployments run unattended — a scheduled sweep, a headless agent —
 * and a client that cannot show a dialog there answers an elicitation with a cancel, which would turn
 * every filter and unsubscribe into an error overnight. `ask` asks where the client can and proceeds
 * where it cannot; `require` refuses where it cannot. Pure, apart from what `askUser` is handed.
 */

export type ConfirmMode = "off" | "ask" | "require";

const MODES: readonly ConfirmMode[] = ["off", "ask", "require"];

export function resolveConfirmMode(env: NodeJS.ProcessEnv): ConfirmMode {
  const raw = env.MAILWARDEN_CONFIRM;
  if (raw === undefined || raw.trim() === "") return "off";
  const v = raw.trim().toLowerCase();
  if (!MODES.includes(v as ConfirmMode)) {
    throw new CliError(`MAILWARDEN_CONFIRM is invalid (${raw}). Set it to one of: ${MODES.join(", ")}.`);
  }
  return v as ConfirmMode;
}

/**
 * `MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG=1`: let the drafts tier save a draft whose new recipients
 * are all the mailbox owner's own address without any dialog, whether or not the client says it can
 * show one: some clients advertise elicitation and decline every request.
 * Only the exact string `1` turns it on, as with the other switches; anything else is off.
 * See `modeFor` in draft-flow.ts for what it does and does not relax.
 */
export function resolveDraftSelfWithoutDialog(env: NodeJS.ProcessEnv): boolean {
  return env.MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG === "1";
}

/**
 * `MAILWARDEN_DRAFT_CONFIRM=off`: the drafts tier asks nobody — not for a new recipient, a file from
 * the disk, a mail's attachment or a sender other than the main address. For an operator who reads
 * every draft in Gmail before pressing Send and wants that review to be the check (asked for by the
 * gmail deployment, 5 Nov 2026). Unset or empty keeps the dialogs; any other value stops the start,
 * like an unknown `MAILWARDEN_CONFIRM`: a value meant as "on" must not be read as anything.
 */
export function resolveDraftDialogOff(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MAILWARDEN_DRAFT_CONFIRM;
  if (raw === undefined || raw.trim() === "") return false;
  if (raw.trim().toLowerCase() === "off") return true;
  throw new CliError(`MAILWARDEN_DRAFT_CONFIRM is invalid (${raw}). Set it to off, or leave it unset.`);
}

/**
 * The mode a draft's question is put in, once `modeFor` (draft-flow.ts) has chosen one. With
 * `MAILWARDEN_DRAFT_CONFIRM=off` nothing is asked, so a decline is never read as a yes; an explicit
 * `MAILWARDEN_CONFIRM=require` still wins, as it does over the self switch.
 */
export function draftConfirmMode(mode: ConfirmMode, configured: ConfirmMode, dialogOff: boolean): ConfirmMode {
  return dialogOff && configured !== "require" ? "off" : mode;
}

export type ConfirmPlan = "proceed" | "ask" | "refuse";

/**
 * The first protocol revision without server-to-client requests. On it a tool cannot put a question
 * mid-call: the dialog would have to be returned as an `input_required` result and answered in a
 * second call, which mailwarden does not do yet (docs/SDK-2-PLAN.md, step 2).
 */
export const FIRST_ERA_WITHOUT_DIALOG = "2026-07-28";

/**
 * Whether the negotiated protocol revision rules the dialog out. Revisions are dates, so they compare
 * as strings. `undefined` (nothing negotiated on this instance, as in stateless HTTP) is not such a
 * revision: what the client can do is then decided by its capabilities, as before.
 */
export function eraWithoutDialog(protocolVersion: string | undefined): boolean {
  return protocolVersion !== undefined && protocolVersion >= FIRST_ERA_WITHOUT_DIALOG;
}

/**
 * The protocol revision that rules the dialog out for this one request, or `undefined` when none
 * does. Two sources, and either is enough:
 *
 * - the revision negotiated on the connection (`eraWithoutDialog`);
 * - the request's own per-request `_meta` envelope (`io.modelcontextprotocol/*` keys, which the
 *   SDK lifts into `ctx.mcpReq.envelope`). Those keys exist only from 2026-07-28 on. A hand-wired
 *   2025 transport still serves such a request when it arrives without any handshake, with nothing
 *   negotiated and no capabilities, and `ask` would read that as "cannot show a dialog" and go
 *   ahead unasked (Grok review of 0.32.0, 21 Nov 2026, measured on stdio, in-memory and stateless
 *   HTTP). Any envelope key counts, whatever revision it claims: a 2025 request carries none.
 */
export function requestEraWithoutDialog(
  negotiated: string | undefined,
  envelope: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (eraWithoutDialog(negotiated)) return negotiated;
  if (envelope !== undefined && Object.keys(envelope).length > 0) return FIRST_ERA_WITHOUT_DIALOG;
  return undefined;
}

/**
 * What to do before a confirmable action, given the mode, whether this client can show a form, and
 * whether the protocol revision rules the dialog out.
 *
 * The last one refuses even under `ask`. On such a connection the client's capabilities read as
 * absent, and `ask` would take that for "cannot show a dialog" and go ahead unasked — a dialog the
 * operator configured would disappear without a word.
 */
export function confirmPlan(mode: ConfirmMode, clientCanAsk: boolean, noDialogInThisEra = false): ConfirmPlan {
  if (mode === "off") return "proceed";
  if (noDialogInThisEra) return "refuse";
  if (clientCanAsk) return "ask";
  return mode === "require" ? "refuse" : "proceed";
}

/** An elicitation result as the SDK returns it — only the fields this reads. */
export interface ElicitAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * Only an accepted form whose box was ticked counts. `accept` with the box left unticked is the
 * user submitting the dialog while saying no, and is read as no.
 */
export function confirmed(answer: ElicitAnswer): boolean {
  return answer.action === "accept" && answer.content?.confirm === true;
}

/** The form every confirmation shows: one required checkbox, default unticked. */
export const CONFIRM_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Yes, do this", default: false },
  },
  required: ["confirm"],
} as const;

/**
 * Sender-chosen text as the dialog may show it: hidden characters stripped, every run of white
 * space or control characters (line breaks included) folded to one space, at most `max`
 * characters. The dialog is the one channel that does not pass through the model, and a display
 * name decoded from RFC 2047 can carry paragraphs and BiDi overrides of the sender's own, such as
 * a made-up "mailwarden checked this unsubscribe" (review grok-mailwarden, 26 Oct).
 */
export function dialogText(s: string, max = 80): string {
  const flat = stripHiddenChars(s)
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u2800]+/g, " ")
    // Stacked combining marks ("Zalgo") fill the line without saying anything; two stay.
    .replace(/(\p{M}{2})\p{M}+/gu, "$1")
    .trim();
  return cutText(flat, max);
}
