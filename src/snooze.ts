import type { Gmail } from "./gmail.js";

/**
 * Snooze is not part of the Gmail API — mailwarden implements it itself.
 * A snoozed thread is archived and tagged with a dated label `MCP/Snoozed/<YYYY-MM-DD>`.
 * `sweepSnoozed` returns due threads to the inbox. Run it on demand, via cron, or a daemon timer.
 */
const PARENT = "MCP/Snoozed";
const datedLabel = (isoDate: string) => `${PARENT}/${isoDate}`;
const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);

/** Max search/modify iterations per dated label — guards against an infinite sweep loop. */
const MAX_SWEEP_ITERATIONS = 1000;

/**
 * A dated snooze label `MCP/Snoozed/<YYYY-MM-DD>` is due when its date is
 * on or before the cutoff (today). ISO date strings compare lexicographically,
 * so a plain `<=` is a valid "due" check. Returns false for non-dated labels.
 */
export function isDue(labelName: string, cutoffIso: string): boolean {
  if (!labelName.startsWith(`${PARENT}/`)) return false;
  const date = labelName.slice(PARENT.length + 1);
  return date <= cutoffIso;
}

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
  const dueLabels = labels.filter((l) => isDue(l.name, cutoff));

  const woken: string[] = [];
  for (const label of dueLabels) {
    // search() caps at 100 results; each modifyLabels strips the dated label off
    // the thread, so re-searching yields the next batch. Loop until empty so a
    // date with >100 threads is fully drained before the label is deleted.
    let iterations = 0;
    for (;;) {
      const batch = await gmail.search(`label:"${label.name}"`, 100);
      if (batch.length === 0) break;
      const remove = [label.id, ...(parent ? [parent.id] : [])];
      for (const t of batch) {
        await gmail.modifyLabels(t.threadId, ["INBOX", "UNREAD"], remove);
        woken.push(t.threadId);
      }
      if (++iterations >= MAX_SWEEP_ITERATIONS) break; // safety: never spin forever
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
