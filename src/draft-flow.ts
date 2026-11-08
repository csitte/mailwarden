/**
 * Drafts — the order of steps around the pure parts in `draft.ts`: read what the draft is built
 * from, decide who must confirm, ask, and only then write. Gmail and the dialog are handed in,
 * so every path here runs in a test against fakes.
 *
 * Nothing in this file sends. The Gmail calls it can reach are `drafts.create`, `drafts.update`
 * and `drafts.get` (plus the read and label calls the rest of mailwarden uses,
 * `messages.attachments.get` for an attachment taken from the thread or kept from the draft, and
 * `settings.sendAs.list` to check a sender, to know the account's own addresses and to read the
 * signature, `messages.list` of the sent mail to say whether a new recipient was written to before,
 * and a second `threads.get` in `full` format when a reply quotes the message it answers);
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
  checkContent,
  checkTotalBytes,
  quoteLines,
  describeFacts,
  draftDialog,
  staticFacts,
  type RecipientFacts,
  isMimeType,
  mimeTypeFor,
  normalizeRecipient,
  normalizeRecipients,
  onlyOwnAddresses,
  replyRecipients,
  replySubject,
  replyThreading,
  unknownRecipients,
  withQuote,
  withSignature,
  signatureOf,
  type Signature,
  type AttachmentSource,
  type DraftAttachment,
  type DraftContent,
  type Recipients,
  type ReplySource,
} from "./draft.js";
import { htmlToText } from "./export.js";
import { addressesOf } from "./signals.js";
import type { Attachment, DraftInfo, DraftRef, ThreadAttachment } from "./gmail.js";

/** The slice of `Gmail` a draft needs. */
export interface DraftGmail {
  getProfile(): Promise<{ emailAddress: string }>;
  replySource(threadId: string, messageId?: string): Promise<{ messageId: string; source: ReplySource }>;
  createDraft(raw: string, threadId?: string): Promise<DraftRef>;
  updateDraft(draftId: string, raw: string, threadId?: string): Promise<DraftRef>;
  getDraft(draftId: string): Promise<DraftInfo>;
  threadAttachments(threadId: string): Promise<ThreadAttachment[]>;
  attachmentBytes(messageId: string, attachmentId: string): Promise<Buffer>;
  sendAsAddresses(): Promise<SendAs[]>;
  /** Whether a mail of this account went to the address before; `undefined` when that cannot be said. */
  sentTo?(address: string): Promise<boolean | undefined>;
  quoteSource(
    threadId: string,
    which: { messageId?: string; rfcMessageId?: string },
  ): Promise<{ name: string; address: string; date: Date; plaintextBody: string; htmlBody: string } | undefined>;
}

/** One address the account may send from: the primary one, or an alias Gmail has verified. */
export interface SendAs {
  address: string;
  primary: boolean;
  /** The signature Gmail's settings hold for this address, as HTML; empty or absent when none. */
  signature?: string;
}

/** Reads one file from MAILWARDEN_ATTACH_DIR (`readAttachmentFile` in attach.ts, a fake in tests). */
export type ReadFile = (path: string) => Promise<{ filename: string; data: Buffer; relative?: string }>;

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
  /** The address the draft goes out from: the main one, or the alias it names. */
  from: string;
  /** For a reply: an alias the answered mail was sent to, when the draft does not use it already. */
  suggestedFrom?: string;
  subject: string;
  /** Addresses that were not in the thread (reply) or in the draft before (update). */
  newRecipients: string[];
  /** What is known about the new recipients: "x@y: never written to, looks like z" — only when there is something to say. */
  recipientNotes?: string[];
  /** Whether the person was shown a dialog and said yes. */
  confirmedByUser: boolean;
  /** The mark that lets update_draft change this draft later. */
  marked: boolean;
  /** Every file the saved draft carries, in order; empty when it carries none. */
  attachments: SavedAttachment[];
  /** Their total size in bytes. */
  attachmentBytes: number;
  /** Only when a quote was asked for: whether the body ends with one. The note says why not. */
  quoted?: boolean;
  /** Whether the draft carries the sender's signature from Gmail's settings. */
  signed: boolean;
  sent: false;
  note: string;
}

export interface ReplyInput {
  threadId: string;
  messageId?: string;
  from?: string;
  replyAll?: boolean;
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  /** Quote the answered message below the body, as a mail client does. */
  quote?: boolean;
  /** Add the sender's signature from Gmail's settings below the body. Default: yes. */
  signature?: boolean;
  attachments?: AttachmentInput[];
}

export interface NewInput {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Add the sender's signature from Gmail's settings below the body. Default: yes. */
  signature?: boolean;
  attachments?: AttachmentInput[];
}

export interface UpdateInput {
  draftId: string;
  /**
   * The draft's messageId as the last create_draft or update_draft returned it. Every save gives a
   * draft a new one — Gmail's editor too — so a different one now means someone changed the draft
   * since, most likely the user in Gmail, and the update is refused instead of overwriting that.
   */
  messageId: string;
  /** Omitted: the draft keeps the sender it has. */
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  /** Quote the message the draft answers below the body again; the new body replaces the old quote too. */
  quote?: boolean;
  /** Add the sender's signature below the new body again. Default: yes; a body that ends with it already is not signed twice. */
  signature?: boolean;
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
 * before, and the sender of an injected mail is a known recipient of their own thread. So does an
 * attachment from a mail that some recipient of the draft never received (`reachesNew`). The
 * opt-in covers either only when the draft goes to the owner alone (see `selfOnly`). A sender
 * other than the main address counts the same way: an injected mail must not get a draft prepared
 * in the name of a band or a firm without the person seeing it.
 *
 * The operator can turn all of this off with `MAILWARDEN_DRAFT_CONFIRM=off`; the tool layer then
 * lowers whatever this returns (`draftConfirmMode` in confirm.ts), so the rule is still stated here.
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
  let inThread: ThreadAttachment[] | undefined;
  const out: DraftAttachment[] = [];
  // What is known so far, so the size limit stops before bytes of a mail are fetched, not after.
  let known = 0;
  for (const input of inputs) {
    if ("path" in input) {
      if (input.filename !== undefined) checkFilename(input.filename);
      const file = await ctx.readFile(input.path);
      const filename = input.filename ?? file.filename;
      checkTotalBytes((known += file.data.length));
      out.push({ filename, mimeType: mimeTypeFor(filename), data: file.data, source: "file", origin: file.relative ?? input.path });
    } else if ("fromMessage" in input) {
      if (!ctx.threadId) {
        throw new ToolError(
          "invalid_input",
          "An attachment from a mail can only go into a reply, from a message of the same thread. A new message has " +
            "no thread: ask the user to put the file into MAILWARDEN_ATTACH_DIR and attach it from there. Nothing was written.",
        );
      }
      inThread ??= await gmail.threadAttachments(ctx.threadId);
      const ofMessage = inThread.filter((a) => a.messageId === input.fromMessage);
      const hits = ofMessage.filter((a) => a.filename === input.filename);
      if (hits.length !== 1) throw threadAttachmentError(input, ofMessage, hits.length);
      const hit = hits[0];
      checkTotalBytes((known += hit.size));
      out.push({
        filename: hit.filename,
        // The sender wrote the type; one that is not a plain type/subtype is replaced, not trusted.
        mimeType: isMimeType(hit.mimeType) ? hit.mimeType : mimeTypeFor(hit.filename),
        data: await gmail.attachmentBytes(hit.messageId, hit.attachmentId),
        source: "message",
        receivedBy: [...normalizeLenient(hit.from), ...normalizeLenient(hit.to), ...normalizeLenient(hit.cc)],
      });
    } else {
      const kept = await keptAttachment(gmail, ctx.draft, input.kept);
      checkTotalBytes((known += kept.data.length));
      out.push(kept);
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
        "Ask the user to put the one meant into MAILWARDEN_ATTACH_DIR and attach it from there. Nothing was written.",
    );
  }
  if (!ofMessage.length) {
    return new ToolError(
      "not_found",
      `Message ${input.fromMessage} is not in this draft's thread, has no attachments, or is a draft or in the trash or spam. ` +
        "An attachment from a mail can only come from a mail of the thread the reply belongs to. Nothing was written.",
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

/**
 * Mark each attachment taken from a mail with the draft's recipients that mail never reached, the
 * owner's own address aside. A thread holds the owner's forwards to others too: a file forwarded to
 * a lawyer is in the thread, and a reply to the other side must not carry it there unasked. Reads
 * the owner's address only when some recipient is outside a mail.
 */
async function markNewReach(list: DraftAttachment[], recipients: Recipients, own: () => Promise<readonly string[]>): Promise<void> {
  const all = [...recipients.to, ...recipients.cc, ...recipients.bcc];
  let mine: readonly string[] | undefined;
  for (const a of list) {
    if (a.source !== "message") continue;
    const outside = all.filter((r) => !(a.receivedBy ?? []).includes(r));
    if (outside.length) mine ??= await own();
    a.newTo = outside.filter((r) => !onlyOwnAddresses([r], mine ?? []));
  }
}

/** Something attached reaches a place it was not before: a file from the disk, or a mail's attachment going further. */
const reachesNew = (list: readonly DraftAttachment[]) => list.some((a) => a.source === "file" || (a.newTo?.length ?? 0) > 0);

/** The account's send-as list, read once per call and only when something needs it. */
function sendAsOnce(gmail: DraftGmail): () => Promise<SendAs[]> {
  let list: Promise<SendAs[]> | undefined;
  const read = async () => {
    const out: SendAs[] = [];
    for (const s of await gmail.sendAsAddresses()) {
      try {
        out.push({ address: normalizeRecipient(s.address), primary: s.primary, signature: s.signature });
      } catch {
        // not an address mailwarden can write: never offered, never matched
      }
    }
    return out;
  };
  return () => (list ??= read());
}

/** The aliases: every send-as address but the main one. */
async function aliasesOf(sendAs: () => Promise<SendAs[]>, main: string): Promise<string[]> {
  return (await sendAs()).filter((s) => !s.primary && s.address !== main).map((s) => s.address);
}

/**
 * The sender a caller asked for, checked: the main address (returned as `undefined`, so no `From`
 * is written and Gmail puts it with the account's name), or an alias on the account's send-as list.
 * Anything else is refused. Gmail would not keep it either — it replaces a `From` it does not
 * accept with the main address when the draft is saved (measured 4 Nov 2026) — but then the result
 * would name a sender the draft does not have.
 */
async function checkFrom(requested: string, main: string, sendAs: () => Promise<SendAs[]>): Promise<string | undefined> {
  const from = normalizeRecipient(requested);
  if (from === main) return undefined;
  const aliases = await aliasesOf(sendAs, main);
  if (aliases.includes(from)) return from;
  throw new ToolError(
    "invalid_input",
    `${from} is not an address this account may send from. It may send from: ${[main, ...aliases].join(", ")} ` +
      "(Gmail's send-as addresses; a new one is added and verified in Gmail's settings). Nothing was written.",
  );
}

export async function saveReplyDraft(
  gmail: DraftGmail,
  input: ReplyInput,
  configured: ConfirmMode,
  confirm: Confirm,
  selfWithoutDialog = false,
  readFile: ReadFile = noFiles,
): Promise<DraftResult> {
  const sendAs = sendAsOnce(gmail);
  const [{ emailAddress }, { messageId: answered, source }] = await Promise.all([
    gmail.getProfile(),
    gmail.replySource(input.threadId, input.messageId),
    sendAs(),
  ]);
  const main = emailAddress.toLowerCase();
  const aliases = await aliasesOf(sendAs, main);
  const from = input.from === undefined ? undefined : await checkFrom(input.from, main, sendAs);
  // Every send-as address is the owner's own here: a mail to the band's alias is not answered to
  // the band. Only here — the self opt-in below still knows the main address alone, since an alias
  // may well forward to someone else.
  const derived = replyRecipients(source, [main, ...aliases], input.replyAll ?? false);
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
  // stranger and the reply to it is asked about. (Bcc is never listed either.) They go through the
  // same normalization as the recipients, or a sender at an internationalised domain would be a
  // stranger to their own thread: the recipient is written in its ASCII form (xn--…), the header
  // may carry the Unicode one.
  const threadAddresses = [...normalizeLenient(source.from), ...normalizeLenient(source.to), ...normalizeLenient(source.cc)];
  const unknown = unknownRecipients(recipients, threadAddresses);
  const facts = await factsFor(gmail, unknown, [...threadAddresses, main, ...aliases], normalizeLenient(source.replyTo));
  const attachments = await resolveAttachments(gmail, input.attachments ?? [], { threadId: input.threadId, readFile });
  const sig = await signatureFor(input.signature, sendAs, from ?? main);
  const quote = input.quote ? await quoteFor(gmail, input.threadId, { messageId: answered }, input.body, sig) : undefined;
  const text = composeText(input.body, sig, quote);
  const content: DraftContent = {
    ...recipients,
    from,
    subject: input.subject ?? replySubject(source.subject),
    ...text.content,
    ...replyThreading(source),
    attachments,
    facts,
  };
  const raw = buildMime(content);
  await markNewReach(attachments, recipients, async () => [emailAddress]);
  const widens = reachesNew(attachments) || from !== undefined;
  const self = await selfOnly(selfWithoutDialog, unknown, async () => [emailAddress], recipients, widens);
  const confirmedByUser = await confirm(modeFor(configured, unknown, self, widens), draftDialog("reply", content, unknown));
  const ref = await gmail.createDraft(raw, input.threadId);
  // The alias the answered mail went to, offered rather than set: the caller decides, and a sender
  // other than the main address is confirmed in the dialog.
  const addressed = [...normalizeLenient(source.to), ...normalizeLenient(source.cc)];
  const suggestedFrom = aliases.find((a) => addressed.includes(a) && a !== from);
  return withSignNote(
    withQuoteResult(
      { ...result(ref, "reply", content, unknown, confirmedByUser, main), ...(suggestedFrom ? { suggestedFrom } : {}) },
      quote,
    ),
    text.signNote,
  );
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
  const main = (await gmail.getProfile()).emailAddress.toLowerCase();
  const sendAs = sendAsOnce(gmail);
  const from = input.from === undefined ? undefined : await checkFrom(input.from, main, sendAs);
  const attachments = await resolveAttachments(gmail, input.attachments ?? [], { readFile: opts.readFile ?? noFiles });
  const text = composeText(input.body, await signatureFor(input.signature, sendAs, from ?? main), undefined);
  const unknown = unknownRecipients(recipients, []);
  const facts = await factsFor(gmail, unknown, [main, ...(await aliasesOf(sendAs, main))]);
  const content: DraftContent = { ...recipients, from, subject: input.subject, ...text.content, attachments, facts };
  const raw = buildMime(content);
  // A new message has no thread to vouch for anyone: always asked, never written unasked — unless
  // the opt-in is on and every recipient is the owner's own address (see `modeFor`).
  const widens = reachesNew(attachments) || from !== undefined;
  const self = await selfOnly(opts.selfWithoutDialog ?? false, unknown, async () => [main], recipients, widens);
  const confirmedByUser = await confirm(modeFor(opts.configured ?? "off", unknown, self, widens), draftDialog("new", content, unknown));
  const ref = await gmail.createDraft(raw);
  return withSignNote(result(ref, "new", content, unknown, confirmedByUser, main), text.signNote);
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
  // Edited in Gmail since mailwarden last saved it: the mark stays on (measured 7 Nov 2026), so
  // without this the update would replace the user's edits without a word.
  unchangedSince(before, input);
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
  const main = (await gmail.getProfile()).emailAddress.toLowerCase();
  // The sender the draft has now. Gmail writes a `From` into every draft it saves: the main address,
  // with the account's name, when mailwarden wrote none.
  const had = normalizeLenient(before.from)[0] ?? main;
  // Omitted keeps it — checked again all the same, so an alias removed since is not written back
  // as if it still held.
  const sendAs = sendAsOnce(gmail);
  const from = await checkFrom(input.from ?? had, main, sendAs);
  const threading = threadingOf(before);
  if (input.quote && !threading.inReplyTo) {
    throw new ToolError("invalid_input", `Draft ${input.draftId} is a new message, not a reply, so it has nothing to quote. Nothing was changed.`);
  }
  // Omitted keeps what the draft carries: an update replaces the whole message, so without this
  // every correction to the text would drop the files without a word.
  const attachments = input.attachments
    ? await resolveAttachments(gmail, input.attachments, {
        threadId: threading.inReplyTo ? before.threadId : undefined,
        draft: before,
        readFile,
      })
    : await keepAll(gmail, before);
  const sig = await signatureFor(input.signature, sendAs, from ?? main);
  const quote =
    input.quote && threading.inReplyTo
      ? await quoteFor(gmail, before.threadId, { rfcMessageId: threading.inReplyTo }, input.body, sig)
      : undefined;
  const text = composeText(input.body, sig, quote);
  const facts = await factsFor(gmail, unknown, [...old.to, ...old.cc, ...old.bcc, main]);
  const content: DraftContent = {
    ...recipients,
    from,
    subject: input.subject ?? before.subject,
    ...text.content,
    ...threading,
    attachments,
    facts,
  };
  const raw = buildMime(content);
  await markNewReach(attachments, recipients, async () => [main]);
  // A sender the draft already had was confirmed when it was set; a new alias is asked about.
  const widens = reachesNew(attachments) || (from !== undefined && from !== had);
  const self = await selfOnly(selfWithoutDialog, unknown, async () => [main], recipients, widens);
  const confirmedByUser = await confirm(modeFor(configured, unknown, self, widens), draftDialog("update", content, unknown));
  // Checked again right before the write: the user may have edited the draft in Gmail while the
  // dialog was open, or while attachments and the quote were fetched (Grok review of 0.31.0, L15).
  // What remains is the moment between this read and the write.
  unchangedSince(await gmail.getDraft(input.draftId), input);
  // A draft that answers a thread is passed its thread again — without it Gmail moves the
  // updated draft into a thread of its own (measured 29 Oct 2026).
  const ref = await gmail.updateDraft(input.draftId, raw, threading.inReplyTo ? before.threadId : undefined);
  return withSignNote(
    withQuoteResult(result(ref, threading.inReplyTo ? "reply" : "new", content, unknown, confirmedByUser, main), quote),
    text.signNote,
  );
}

/** At most this many new recipients are looked up in the sent mail: one `messages.list` each. */
const MAX_HISTORY_LOOKUPS = 10;

/**
 * What is known about each new recipient: the facts that need no call (`staticFacts`), and whether
 * the account wrote to the address before — one `messages.list` of the sent mail each, for the
 * first ten. A failed lookup says nothing rather than "never": the draft is not held up by it.
 */
async function factsFor(
  gmail: DraftGmail,
  unknown: readonly string[],
  known: readonly string[],
  replyTo: readonly string[] = [],
): Promise<Record<string, RecipientFacts>> {
  const facts = staticFacts(unknown, known, replyTo);
  if (!gmail.sentTo) return facts;
  const lookups = unknown.slice(0, MAX_HISTORY_LOOKUPS);
  const answers = await Promise.all(lookups.map((a) => gmail.sentTo!(a).catch(() => undefined)));
  lookups.forEach((a, i) => {
    if (answers[i] !== undefined) facts[a] = { ...facts[a], writtenTo: answers[i] };
  });
  return facts;
}

/**
 * The signature for the address the draft goes out from, unless the caller said no: the one Gmail's
 * settings hold for that send-as address (the main address's for a draft without an alias). None
 * when the address has none. Reads the send-as list, which a reply reads anyway.
 */
async function signatureFor(wanted: boolean | undefined, sendAs: () => Promise<SendAs[]>, address: string): Promise<Signature | undefined> {
  if (wanted === false) return undefined;
  return signatureOf((await sendAs()).find((s) => s.address === address)?.signature);
}

/**
 * The draft's text and HTML: the body, the signature, the quote. A quote that was made carries the
 * signature already (between body and quote); without one the signature is added here. A body too
 * long to take the signature is saved without it, and the note says so.
 */
function composeText(
  body: string,
  sig: Signature | undefined,
  quote: { body: string; html?: string; quotes?: string } | undefined,
): { content: Pick<DraftContent, "body" | "html" | "quotes" | "signature">; signNote?: string } {
  if (quote?.quotes !== undefined) {
    return { content: { body: quote.body, html: quote.html, quotes: quote.quotes, ...(sig ? { signature: sig.text } : {}) } };
  }
  if (!sig) return { content: { body } };
  const r = withSignature(body, sig);
  if ("reason" in r) return { content: { body }, signNote: r.reason };
  return { content: { body: r.body, html: r.html, signature: sig.text } };
}

function notesOf(unknown: readonly string[], facts: Record<string, RecipientFacts> | undefined): { recipientNotes?: string[] } {
  const notes = unknown.flatMap((a) => {
    const said = describeFacts(facts?.[a]);
    return said.length ? [`${a}: ${said.join(", ")}`] : [];
  });
  return notes.length ? { recipientNotes: notes } : {};
}

function withSignNote(r: DraftResult, reason: string | undefined): DraftResult {
  return reason ? { ...r, note: `${r.note} No signature was added: ${reason}.` } : r;
}

/**
 * The body with the answered message quoted below it — as text, and the same as HTML in Gmail's
 * quote markup so Gmail shows it as a quote block —, or the body alone and the reason. Never fatal: a reply without
 * its quote is still the reply the caller wrote, and the result says so. The line above the quote
 * is written in the locale and time zone of the machine mailwarden runs on — the account's Gmail
 * language would need another settings endpoint opened.
 */
async function quoteFor(
  gmail: DraftGmail,
  threadId: string,
  which: { messageId?: string; rfcMessageId?: string },
  body: string,
  sig?: Signature,
): Promise<{ body: string; html?: string; quotes?: string; reason?: string }> {
  // A body over the limit fails in buildMime whatever the quote does; said here, before a
  // threads.get is spent on it and before "too long to quote" would blame the quoted mail.
  checkContent("", body);
  const q = await gmail.quoteSource(threadId, which);
  if (!q) return { body, reason: "the message this draft answers is no longer in the thread" };
  // The text part when it has lines to quote, else the HTML part reduced to text. Judged by the
  // same rule that later decides whether there is anything to quote: a text part that is nothing
  // but Outlook's `[cid:…]` placeholders counts as empty (Grok review N35, 6 Nov 2026).
  const text = quoteLines(q.plaintextBody).length ? q.plaintextBody : htmlToText(q.htmlBody);
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const r = withQuote(body, { name: q.name, address: q.address, date: q.date, text }, locale, timeZone, sig);
  return "reason" in r ? { body, reason: r.reason } : { body: r.body, html: r.html, quotes: r.attribution };
}

function withQuoteResult(r: DraftResult, quote: { quotes?: string; reason?: string } | undefined): DraftResult {
  if (!quote) return r;
  if (quote.quotes !== undefined) return { ...r, quoted: true };
  return { ...r, quoted: false, note: `${r.note} No quote was added: ${quote.reason}.` };
}

/** Every attachment the draft carries, re-read so the update can write it again. */
async function keepAll(gmail: DraftGmail, draft: DraftInfo): Promise<DraftAttachment[]> {
  checkTotalBytes(draft.attachments.reduce((n, a) => n + a.size, 0));
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
/** Refuses a draft whose messageId is no longer the one the caller last saw: someone changed it since. */
function unchangedSince(now: DraftInfo, input: UpdateInput): void {
  if (now.messageId === input.messageId) return;
  throw new ToolError(
    "invalid_input",
    `Draft ${input.draftId} was changed since messageId ${input.messageId} — its messageId is now ${now.messageId}, ` +
      "most likely because the user edited it in Gmail. Nothing was changed. Read it with get_thread " +
      `(threadId ${now.threadId}) and ask the user before replacing their edits; to replace them, call ` +
      `update_draft again with messageId ${now.messageId}.`,
  );
}

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
  main: string,
): DraftResult {
  return {
    draftId: ref.draftId,
    messageId: ref.messageId,
    threadId: ref.threadId,
    kind,
    from: content.from ?? main,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    newRecipients: unknown,
    ...notesOf(unknown, content.facts),
    confirmedByUser,
    marked: ref.marked,
    attachments: (content.attachments ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      bytes: a.data.length,
      source: a.source,
    })),
    attachmentBytes: attachmentBytes(content.attachments ?? []),
    signed: content.signature !== undefined,
    sent: false,
    note: ref.marked
      ? "Saved as a draft, not sent. The user reviews and sends it from Gmail's Drafts."
      : "Saved as a draft, not sent. The mark could not be set, so update_draft will refuse this draft; " +
        "the user can still edit and send it in Gmail.",
  };
}
