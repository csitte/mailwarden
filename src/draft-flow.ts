/**
 * Drafts — the order of steps around the pure parts in `draft.ts`: read what the draft is built
 * from, decide who must confirm, ask, and only then write. Gmail and the dialog are handed in,
 * so every path here runs in a test against fakes.
 *
 * Nothing in this file sends. The Gmail calls it can reach are `drafts.create`, `drafts.update`
 * and `drafts.get` (plus the read and label calls the rest of mailwarden uses); `drafts.send`
 * and `messages.send` stay refused in src/egress.ts whatever is enabled.
 */

import { ToolError } from "./cli.js";
import type { ConfirmMode } from "./confirm.js";
import {
  buildMime,
  draftDialog,
  normalizeRecipients,
  onlyOwnAddresses,
  replyRecipients,
  replySubject,
  replyThreading,
  unknownRecipients,
  type DraftContent,
  type Recipients,
  type ReplySource,
} from "./draft.js";
import { addressesOf } from "./signals.js";
import type { DraftInfo, DraftRef } from "./gmail.js";

/** The slice of `Gmail` a draft needs. */
export interface DraftGmail {
  getProfile(): Promise<{ emailAddress: string }>;
  replySource(threadId: string, messageId?: string): Promise<{ messageId: string; source: ReplySource }>;
  createDraft(raw: string, threadId?: string): Promise<DraftRef>;
  updateDraft(draftId: string, raw: string, threadId?: string): Promise<DraftRef>;
  getDraft(draftId: string): Promise<DraftInfo>;
}

/**
 * Ask the person, in the given mode. Resolves when the draft may be written — `true` if a dialog
 * was shown and answered yes, `false` if the mode let it pass unasked — and throws
 * `declined_by_user` otherwise. `require` is what an unknown recipient forces.
 */
export type Confirm = (mode: ConfirmMode, message: string) => Promise<boolean>;

export interface DraftResult extends Recipients {
  draftId: string;
  messageId: string;
  threadId: string;
  kind: "reply" | "new";
  subject: string;
  /** Addresses that were not in the thread (reply) or in the draft before (update). */
  newRecipients: string[];
  /** Whether the person was shown a dialog and said yes. */
  confirmedByUser: boolean;
  /** The mark that lets update_draft change this draft later. */
  marked: boolean;
  sent: false;
  note: string;
}

export interface ReplyInput {
  threadId: string;
  messageId?: string;
  replyAll?: boolean;
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
}

export interface NewInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface UpdateInput {
  draftId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
}

/**
 * The confirmation mode that applies: `require` once any recipient is new, else the configured one.
 *
 * The one exception is the opt-in `MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG=1` (`selfWithoutDialog`):
 * when every new recipient is the mailbox owner's own address, the draft cannot reach a third
 * party, so `require` relaxes to `ask` — a client that can show the dialog still shows it, a client
 * that cannot (no MCP elicitation) saves the draft. An explicit `MAILWARDEN_CONFIRM=require` is
 * never relaxed. Anything with a foreign new recipient stays `require`, opt-in or not.
 */
function modeFor(configured: ConfirmMode, unknown: readonly string[], selfOnly: boolean): ConfirmMode {
  if (!unknown.length) return configured;
  if (selfOnly) return configured === "require" ? "require" : "ask";
  return "require";
}

/**
 * Whether the opt-in applies to these new recipients. Reads the owner's address only when the
 * opt-in is on, so with it off nothing extra is called.
 */
async function selfOnly(
  optIn: boolean,
  unknown: readonly string[],
  own: () => Promise<readonly string[]>,
): Promise<boolean> {
  if (!optIn || unknown.length === 0) return false;
  return onlyOwnAddresses(unknown, await own());
}

export async function saveReplyDraft(
  gmail: DraftGmail,
  input: ReplyInput,
  configured: ConfirmMode,
  confirm: Confirm,
  selfWithoutDialog = false,
): Promise<DraftResult> {
  const [{ emailAddress }, { source }] = await Promise.all([
    gmail.getProfile(),
    gmail.replySource(input.threadId, input.messageId),
  ]);
  const derived = replyRecipients(source, [emailAddress], input.replyAll ?? false);
  const extraCc = normalizeRecipients(input.cc).filter((a) => !derived.to.includes(a) && !derived.cc.includes(a));
  const recipients: Recipients = {
    to: derived.to,
    cc: [...derived.cc, ...extraCc],
    bcc: normalizeRecipients(input.bcc),
  };
  if (recipients.to.length === 0) {
    throw new ToolError(
      "invalid_input",
      "The message being answered has no address mailwarden can reply to (its From/Reply-To/To did not parse, " +
        "or name only this account). Nothing was written; use create_draft without threadId and name the recipient.",
    );
  }
  // Every address the thread itself supplied, whether or not this reply uses it: a reply that
  // goes to fewer people than reply-all is no reason to ask. Reply-To is deliberately not
  // among them: the sender alone chooses it, so a Reply-To that is not also in From/To/Cc is a
  // stranger and the reply to it is asked about. (Bcc is never listed either.)
  const threadAddresses = [...addressesOf(source.from), ...addressesOf(source.to), ...addressesOf(source.cc)];
  const unknown = unknownRecipients(recipients, threadAddresses);
  const content: DraftContent = {
    ...recipients,
    subject: input.subject ?? replySubject(source.subject),
    body: input.body,
    ...replyThreading(source),
  };
  const raw = buildMime(content);
  const self = await selfOnly(selfWithoutDialog, unknown, async () => [emailAddress]);
  const confirmedByUser = await confirm(modeFor(configured, unknown, self), draftDialog("reply", content, unknown));
  const ref = await gmail.createDraft(raw, input.threadId);
  return result(ref, "reply", content, unknown, confirmedByUser);
}

export async function saveNewDraft(
  gmail: DraftGmail,
  input: NewInput,
  confirm: Confirm,
  opts: { configured?: ConfirmMode; selfWithoutDialog?: boolean } = {},
): Promise<DraftResult> {
  const recipients: Recipients = {
    to: normalizeRecipients(input.to),
    cc: normalizeRecipients(input.cc),
    bcc: normalizeRecipients(input.bcc),
  };
  const content: DraftContent = { ...recipients, subject: input.subject, body: input.body };
  const raw = buildMime(content);
  const unknown = unknownRecipients(recipients, []);
  // A new message has no thread to vouch for anyone: always asked, never written unasked — unless
  // the opt-in is on and every recipient is the owner's own address (see `modeFor`).
  const self = await selfOnly(opts.selfWithoutDialog ?? false, unknown, async () => [(await gmail.getProfile()).emailAddress]);
  const confirmedByUser = await confirm(modeFor(opts.configured ?? "off", unknown, self), draftDialog("new", content, unknown));
  const ref = await gmail.createDraft(raw);
  return result(ref, "new", content, unknown, confirmedByUser);
}

export async function reviseDraft(
  gmail: DraftGmail,
  input: UpdateInput,
  configured: ConfirmMode,
  confirm: Confirm,
  selfWithoutDialog = false,
): Promise<DraftResult> {
  const before = await gmail.getDraft(input.draftId);
  if (!before.ownedByMailwarden) {
    throw new ToolError(
      "forbidden_operation",
      `Draft ${input.draftId} was not written by mailwarden (it lacks the mark create_draft sets), so mailwarden ` +
        "will not overwrite it. Nothing was changed; create a new draft instead.",
    );
  }
  if (before.trashed) {
    throw new ToolError("invalid_input", `Draft ${input.draftId} is in the trash. Nothing was changed.`);
  }
  const old: Recipients = {
    to: normalizeLenient(before.to),
    cc: normalizeLenient(before.cc),
    bcc: normalizeLenient(before.bcc),
  };
  const recipients: Recipients = {
    to: input.to ? normalizeRecipients(input.to) : old.to,
    cc: input.cc ? normalizeRecipients(input.cc) : old.cc,
    bcc: input.bcc ? normalizeRecipients(input.bcc) : old.bcc,
  };
  const unknown = unknownRecipients(recipients, [...old.to, ...old.cc, ...old.bcc]);
  const threading = threadingOf(before);
  const content: DraftContent = {
    ...recipients,
    subject: input.subject ?? before.subject,
    body: input.body,
    ...threading,
  };
  const raw = buildMime(content);
  const self = await selfOnly(selfWithoutDialog, unknown, async () => [(await gmail.getProfile()).emailAddress]);
  const confirmedByUser = await confirm(modeFor(configured, unknown, self), draftDialog("update", content, unknown));
  // A draft that answers a thread is passed its thread again — without it Gmail moves the
  // updated draft into a thread of its own (measured 29 Oct 2026).
  const ref = await gmail.updateDraft(input.draftId, raw, threading.inReplyTo ? before.threadId : undefined);
  return result(ref, threading.inReplyTo ? "reply" : "new", content, unknown, confirmedByUser);
}

/** A saved draft's own header, read back: addresses that no longer parse are dropped, not fatal. */
function normalizeLenient(value: string | undefined): string[] {
  const out: string[] = [];
  for (const a of addressesOf(value)) {
    try {
      out.push(...normalizeRecipients([a]));
    } catch {
      // left out
    }
  }
  return [...new Set(out)];
}

/** The threading a saved draft already carries, passed through the same msg-id filter as a reply. */
function threadingOf(d: DraftInfo): { inReplyTo?: string; references?: string } {
  if (!d.inReplyTo) return {};
  return replyThreading({ messageId: d.inReplyTo, references: d.references });
}

function result(
  ref: DraftRef,
  kind: "reply" | "new",
  content: DraftContent,
  unknown: string[],
  confirmedByUser: boolean,
): DraftResult {
  return {
    draftId: ref.draftId,
    messageId: ref.messageId,
    threadId: ref.threadId,
    kind,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    newRecipients: unknown,
    confirmedByUser,
    marked: ref.marked,
    sent: false,
    note: ref.marked
      ? "Saved as a draft, not sent. The user reviews and sends it from Gmail's Drafts."
      : "Saved as a draft, not sent. The mark could not be set, so update_draft will refuse this draft; " +
        "the user can still edit and send it in Gmail.",
  };
}
