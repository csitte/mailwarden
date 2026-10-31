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
 * are all the mailbox owner's own address without a dialog, on a client that cannot show one.
 * Only the exact string `1` turns it on, as with the other switches; anything else is off.
 * See `modeFor` in draft-flow.ts for what it does and does not relax.
 */
export function resolveDraftSelfWithoutDialog(env: NodeJS.ProcessEnv): boolean {
  return env.MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG === "1";
}

export type ConfirmPlan = "proceed" | "ask" | "refuse";

/** What to do before a confirmable action, given the mode and whether this client can show a form. */
export function confirmPlan(mode: ConfirmMode, clientCanAsk: boolean): ConfirmPlan {
  if (mode === "off") return "proceed";
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
