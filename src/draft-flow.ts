/**
 * Drafts — the order of steps around the pure parts in `draft.ts`: read what the draft is built
 * from, decide who must confirm, ask, and only then write. Gmail and the dialog are handed in,
 * so every path here runs in a test against fakes.
 *
 * Nothing in this file sends. The Gmail calls it can reach are `drafts.create`, `drafts.update`
 * and `drafts.get` (plus the read and label calls the rest of mailwarden uses, and
 * `messages.attachments.get` for an attachment taken from the thread or kept from the draft);
 * `drafts.send` and `messages.send` stay refused in src/egress.ts whatever is enabled.
 */

import { ToolError } from "./cli.js";
import type { ConfirmMode } from "./confirm.js";
import {
  MAX_ATTACHMENTS,
  attachmentBytes,
  buildMime,
  checkAttachments,
  checkFilename,
  draftDialog,
  isMimeType,
  mimeTypeFor,
  normalizeRecipients,
  onlyOwnAddresses,
  replyRecipients,
  replySubject,
  replyThreading,
  unknownRecipients,
  type AttachmentSource,
  type DraftAttachment,
  type DraftContent,
  type Recipients,
  type ReplySource,
} from "./draft.js";
import { addressesOf } from "./signals.js";
import type { Attachment, DraftInfo, DraftRef } from "./gmail.js";

/** The slice of `Gmail` a draft needs. */
export interface DraftGmail {
  getProfile(): Promise<{ emailAddress: string }>;
  replySource(threadId: string, messageId?: string): Promise<{ messageId: string; source: ReplySource }>;
  createDraft(raw: string, threadId?: string): Promise<DraftRef>;
  updateDraft(draftId: string, raw: string, threadId?: string): Promise<DraftRef>;
  getDraft(draftId: string): Promise<DraftInfo>;
  threadAttachments(threadId: string): Promise<Attachment[]>;
  attachmentBytes(messageId: string, attachmentId: string): Promise<Buffer>;
}

/** Reads one file from MAILWARDEN_ATTACH_DIR (`readAttachmentFile` in attach.ts, a fake in tests). */
export type ReadFile = (path: string) => Promise<{ filename: string; data: Buffer }>;

/** No directory configured: every file attachment is refused, with the reason. */
const noFiles: ReadFile = async () => {
  throw new ToolError(
    "invalid_input",
    "Attachments from files are off: the operator has not set MAILWARDEN_ATTACH_DIR. Nothing was written.",
  );
};

/**
 * One attachment as the caller names it. A file in MAILWARDEN_ATTACH_DIR (`filename` renames it);
 * an attachment of a message in the draft's own thread, by that message and its filename — Gmail's
 * attachment ids change on every read, so they cannot name one; or, for update_draft only, an
 * attachment the draft already carries.
 */
export type AttachmentInput = { path: string; filename?: string } | { fromMessage: string; filename: string } | { kept: string };

/** An attachment as the result reports it: what was saved, without the bytes. */
export interface SavedAttachment {
  filename: string;
  mimeType: string;
  bytes: number;
  source: AttachmentSource;
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
  /** Every file the saved draft carries, in order; empty when it carries none. */
  attachments: SavedAttachment[];
  /** Their total size in bytes. */
  attachmentBytes: number;
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
  attachments?: AttachmentInput[];
}

export interface NewInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: AttachmentInput[];
}

export interface UpdateInput {
  draftId: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  /** Omitted: the draft keeps the attachments it has. Given: the new list, `[]` for none. */
  attachments?: AttachmentInput[];
}

/**
 * The confirmation mode that applies: `require` once any recipient is new, else the configured one.
 *
 * The one exception is the opt-in `MAILWARDEN_DRAFT_SELF_WITHOUT_DIALOG=1` (`selfWithoutDialog`):
 * when every new recipient is the mailbox owner's own address, the draft cannot reach a third
 * party, so `require` relaxes to `off` — nobody is asked, whatever the client can do. `ask` was
 * the first cut (0.27.0), and it left the switch without effect on a client that advertises MCP
 * elicitation but cannot show the dialog: it still got a question, and its silent decline was a no.
 * `off` means `confirmPlan` proceeds and `confirmedByUser` is false — a decline or cancel is never
 * read as a yes, because no question is put. An explicit `MAILWARDEN_CONFIRM=require` is never
 * relaxed. Anything with a foreign new recipient stays `require`, opt-in or not.
 *
 * A file from the disk (`newFiles`) counts like a new recipient: it reaches a place it was not
 * before, and the sender of an injected mail is a known recipient of their own thread. The opt-in
 * covers it only when the draft goes to the owner alone (see `selfOnly`).
 */
function modeFor(configured: ConfirmMode, unknown: readonly string[], selfOnly: boolean, newFiles = false): ConfirmMode {
  if (!unknown.length && !newFiles) return configured;
  if (selfOnly) return configured === "require" ? "require" : "off";
  return "require";
}

/**
 * Whether the opt-in applies: every new recipient is the owner's address, and when a file from the
 * disk is attached, every recipient is — a file to yourself reaches no one else, a file to a known
 * correspondent does. Reads the owner's address only when the opt-in is on and something would be
 * asked, so with it off nothing extra is called.
 */
async function selfOnly(
  optIn: boolean,
  unknown: readonly string[],
  own: () => Promise<readonly string[]>,
  recipients?: Recipients,
  newFiles = false,
): Promise<boolean> {
  if (!optIn || (unknown.length === 0 && !newFiles)) return false;
  const mine = await own();
  if (unknown.length && !onlyOwnAddresses(unknown, mine)) return false;
  if (!newFiles) return true;
  return recipients !== undefined && onlyOwnAddresses([...recipients.to, ...recipients.cc, ...recipients.bcc], mine);
}

/**
 * Turn what the caller named into the files themselves, in order. Nothing is written here; the
 * count is checked before anything is read, and size, names and types again when the message is
 * built. `threadId` is the draft's thread (none for a new message), `draft` the draft being revised.
 */
async function resolveAttachments(
  gmail: DraftGmail,
  inputs: readonly AttachmentInput[],
  ctx: { threadId?: string; draft?: DraftInfo; readFile: ReadFile },
): Promise<DraftAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new ToolError(
      "invalid_input",
      `A draft may carry at most ${MAX_ATTACHMENTS} attachments (got ${inputs.length}); nothing was written.`,
    );
  }
  let inThread: Attachment[] | undefined;
  const out: DraftAttachment[] = [];
  for (const input of inputs) {
    if ("path" in input) {
      if (input.filename !== undefined) checkFilename(input.filename);
      const file = await ctx.readFile(input.path);
      const filename = input.filename ?? file.filename;
      out.push({ filename, mimeType: mimeTypeFor(filename), data: file.data, source: "file" });
    } else if ("fromMessage" in input) {
      if (!ctx.threadId) {
        throw new ToolError(
          "invalid_input",
          "An attachment from a mail can only go into a reply, from a message of the same thread. A new message has " +
            "no thread: save the file into MAILWARDEN_ATTACH_DIR with download_attachment and attach it from there.",
        );
      }
      inThread ??= await gmail.threadAttachments(ctx.threadId);
      const ofMessage = inThread.filter((a) => a.messageId === input.fromMessage);
      const hits = ofMessage.filter((a) => a.filename === input.filename);
      if (hits.length !== 1) throw threadAttachmentError(input, ofMessage, hits.length);
      const hit = hits[0];
      out.push({
        filename: hit.filename,
        // The sender wrote the type; one that is not a plain type/subtype is replaced, not trusted.
        mimeType: isMimeType(hit.mimeType) ? hit.mimeType : mimeTypeFor(hit.filename),
        data: await gmail.attachmentBytes(hit.messageId, hit.attachmentId),
        source: "message",
      });
    } else {
      out.push(await keptAttachment(gmail, ctx.draft, input.kept));
    }
  }
  return out;
}

function threadAttachmentError(
  input: { fromMessage: string; filename: string },
  ofMessage: readonly Attachment[],
  found: number,
): ToolError {
  if (found > 1) {
    return new ToolError(
      "invalid_input",
      `Message ${input.fromMessage} carries ${found} attachments named "${input.filename}", so the name does not say which. ` +
        "Save the one you mean into MAILWARDEN_ATTACH_DIR with download_attachment and attach it from there. Nothing was written.",
    );
  }
  if (!ofMessage.length) {
    return new ToolError(
      "not_found",
      `Message ${input.fromMessage} is not in this draft's thread, or has no attachments. An attachment from a mail can only ` +
        "come from the thread the reply belongs to. Nothing was written.",
    );
  }
  return new ToolError(
    "not_found",
    `Message ${input.fromMessage} has no attachment named "${input.filename}"; it has: ` +
      `${ofMessage.map((a) => `"${a.filename}"`).join(", ")}. Nothing was written.`,
  );
}

async function keptAttachment(gmail: DraftGmail, draft: DraftInfo | undefined, filename: string): Promise<DraftAttachment> {
  if (!draft) {
    throw new ToolError("invalid_input", "`kept` names an attachment the draft already has, so it only applies to update_draft.");
  }
  const hits = draft.attachments.filter((a) => a.filename === filename);
  if (hits.length === 0) {
    throw new ToolError(
      "not_found",
      `The draft has no attachment named "${filename}"` +
        (draft.attachments.length ? `; it has: ${draft.attachments.map((a) => `"${a.filename}"`).join(", ")}.` : ", it has none.") +
        " Nothing was written.",
    );
  }
  if (hits.length > 1) {
    throw new ToolError(
      "invalid_input",
      `The draft carries ${hits.length} attachments named "${filename}". Omit attachments to keep them all, or pass [] and attach anew. Nothing was written.`,
    );
  }
  return keep(gmail, hits[0]);
}

async function keep(gmail: DraftGmail, a: Attachment): Promise<DraftAttachment> {
  return {
    filename: a.filename,
    mimeType: isMimeType(a.mimeType) ? a.mimeType : mimeTypeFor(a.filename),
    data: await gmail.attachmentBytes(a.messageId, a.attachmentId),
    source: "kept",
  };
}

const hasNewFiles = (list: readonly DraftAttachment[]) => list.some((a) => a.source === "file");

export async function saveReplyDraft(
  gmail: DraftGmail,
  input: ReplyInput,
  configured: ConfirmMode,
  confirm: Confirm,
  selfWithoutDialog = false,
  readFile: ReadFile = noFiles,
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
  const attachments = await resolveAttachments(gmail, input.attachments ?? [], { threadId: input.threadId, readFile });
  const content: DraftContent = {
    ...recipients,
    subject: input.subject ?? replySubject(source.subject),
    body: input.body,
    ...replyThreading(source),
    attachments,
  };
  const raw = buildMime(content);
  const files = hasNewFiles(attachments);
  const self = await selfOnly(selfWithoutDialog, unknown, async () => [emailAddress], recipients, files);
  const confirmedByUser = await confirm(modeFor(configured, unknown, self, files), draftDialog("reply", content, unknown));
  const ref = await gmail.createDraft(raw, input.threadId);
  return result(ref, "reply", content, unknown, confirmedByUser);
}

export async function saveNewDraft(
  gmail: DraftGmail,
  input: NewInput,
  confirm: Confirm,
  opts: { configured?: ConfirmMode; selfWithoutDialog?: boolean; readFile?: ReadFile } = {},
): Promise<DraftResult> {
  const recipients: Recipients = {
    to: normalizeRecipients(input.to),
    cc: normalizeRecipients(input.cc),
    bcc: normalizeRecipients(input.bcc),
  };
  const attachments = await resolveAttachments(gmail, input.attachments ?? [], { readFile: opts.readFile ?? noFiles });
  const content: DraftContent = { ...recipients, subject: input.subject, body: input.body, attachments };
  const raw = buildMime(content);
  const unknown = unknownRecipients(recipients, []);
  // A new message has no thread to vouch for anyone: always asked, never written unasked — unless
  // the opt-in is on and every recipient is the owner's own address (see `modeFor`).
  const files = hasNewFiles(attachments);
  const self = await selfOnly(
    opts.selfWithoutDialog ?? false,
    unknown,
    async () => [(await gmail.getProfile()).emailAddress],
    recipients,
    files,
  );
  const confirmedByUser = await confirm(modeFor(opts.configured ?? "off", unknown, self, files), draftDialog("new", content, unknown));
  const ref = await gmail.createDraft(raw);
  return result(ref, "new", content, unknown, confirmedByUser);
}

export async function reviseDraft(
  gmail: DraftGmail,
  input: UpdateInput,
  configured: ConfirmMode,
  confirm: Confirm,
  selfWithoutDialog = false,
  readFile: ReadFile = noFiles,
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
  // Omitted keeps what the draft carries: an update replaces the whole message, so without this
  // every correction to the text would drop the files without a word.
  const attachments = input.attachments
    ? await resolveAttachments(gmail, input.attachments, {
        threadId: threading.inReplyTo ? before.threadId : undefined,
        draft: before,
        readFile,
      })
    : await keepAll(gmail, before);
  const content: DraftContent = {
    ...recipients,
    subject: input.subject ?? before.subject,
    body: input.body,
    ...threading,
    attachments,
  };
  const raw = buildMime(content);
  const files = hasNewFiles(attachments);
  const self = await selfOnly(
    selfWithoutDialog,
    unknown,
    async () => [(await gmail.getProfile()).emailAddress],
    recipients,
    files,
  );
  const confirmedByUser = await confirm(modeFor(configured, unknown, self, files), draftDialog("update", content, unknown));
  // A draft that answers a thread is passed its thread again — without it Gmail moves the
  // updated draft into a thread of its own (measured 29 Oct 2026).
  const ref = await gmail.updateDraft(input.draftId, raw, threading.inReplyTo ? before.threadId : undefined);
  return result(ref, threading.inReplyTo ? "reply" : "new", content, unknown, confirmedByUser);
}

/** Every attachment the draft carries, re-read so the update can write it again. */
async function keepAll(gmail: DraftGmail, draft: DraftInfo): Promise<DraftAttachment[]> {
  const kept: DraftAttachment[] = [];
  for (const a of draft.attachments) kept.push(await keep(gmail, a));
  checkAttachments(kept);
  return kept;
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
    attachments: (content.attachments ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      bytes: a.data.length,
      source: a.source,
    })),
    attachmentBytes: attachmentBytes(content.attachments ?? []),
    sent: false,
    note: ref.marked
      ? "Saved as a draft, not sent. The user reviews and sends it from Gmail's Drafts."
      : "Saved as a draft, not sent. The mark could not be set, so update_draft will refuse this draft; " +
        "the user can still edit and send it in Gmail.",
  };
}
