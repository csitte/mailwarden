import type { Gmail } from "./gmail.js";

/**
 * Snooze is not part of the Gmail API — mailwarden implements it itself.
 * A snoozed thread is archived and tagged with a dated label `MCP/Snoozed/<YYYY-MM-DD>`.
 * `sweepSnoozed` returns due threads to the inbox. Run it on demand, via cron, or a daemon timer.
 */
const PARENT = "MCP/Snoozed";
const datedLabel = (isoDate: string) => `${PARENT}/${isoDate}`;
const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);

export async function snooze(gmail: Gmail, threadId: string, until: string) {
  const parentId = await gmail.ensureLabel(PARENT);
  const dueId = await gmail.ensureLabel(datedLabel(until));
  await gmail.modifyLabels(threadId, [parentId, dueId], ["INBOX"]);
  return { threadId, snoozedUntil: until };
}

export async function unsnooze(gmail: Gmail, threadId: string) {
  const remove = (await gmail.listLabels())
    .filter((l) => l.name === PARENT || l.name.startsWith(`${PARENT}/`))
    .map((l) => l.id);
  await gmail.modifyLabels(threadId, ["INBOX"], remove);
  return { threadId, unsnoozed: true };
}

export async function listSnoozed(gmail: Gmail) {
  const dateLabels = (await gmail.listLabels()).filter((l) => l.name.startsWith(`${PARENT}/`));
  const out: { threadId: string; subject: string; snoozedUntil: string }[] = [];
  for (const label of dateLabels) {
    const due = label.name.slice(PARENT.length + 1);
    for (const t of await gmail.search(`label:"${label.name}"`, 100)) {
      out.push({ threadId: t.threadId, subject: t.subject, snoozedUntil: due });
    }
  }
  return out.sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil));
}

export async function sweepSnoozed(gmail: Gmail, today = new Date()) {
  const cutoff = todayIso(today);
  const labels = await gmail.listLabels();
  const parent = labels.find((l) => l.name === PARENT);
  // ISO date strings compare lexicographically, so `<=` is a valid "due" check.
  const dueLabels = labels.filter(
    (l) => l.name.startsWith(`${PARENT}/`) && l.name.slice(PARENT.length + 1) <= cutoff,
  );

  const woken: string[] = [];
  for (const label of dueLabels) {
    for (const t of await gmail.search(`label:"${label.name}"`, 100)) {
      const remove = [label.id, ...(parent ? [parent.id] : [])];
      await gmail.modifyLabels(t.threadId, ["INBOX", "UNREAD"], remove);
      woken.push(t.threadId);
    }
    // dated label is now empty — tidy up
    try {
      await gmail.deleteLabel(label.id);
    } catch {
      /* ignore */
    }
  }
  return { date: cutoff, wokenCount: woken.length, woken };
}
