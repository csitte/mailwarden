# Gmail's thread index can answer `is:unread` from a stale read state

A measured report. In one real Gmail mailbox, the `threads.list` endpoint returned threads for
`is:unread` in which no message was unread — the large majority of what came back. The same query,
in the same mailbox, in the same minute, asked through `messages.list` instead, returned no stale
hit at all. A second mailbox, measured the same way on the same day, did not drift at all.

This document exists so the finding can be read, cited and reproduced on its own, without reading
the software it was found in. It was found while building
[mailwarden](https://github.com/csitte/mailwarden), a Gmail MCP server; the last section says what
that server does about it, and nothing before that section depends on it.

- **Date of measurement:** 2026-08-15, with a follow-up the night after.
- **Access used:** read-only, metadata only. No subject, sender or body was fetched.
- **Reproduction:** [`scripts/probe-reverify.mjs`](https://github.com/csitte/mailwarden/blob/main/scripts/probe-reverify.mjs)
  in your own mailbox; [`scripts/demo-reverify.mjs`](https://github.com/csitte/mailwarden/blob/main/scripts/demo-reverify.mjs)
  against a fake API, with no Google account at all.
- **Raw figures with their provenance:**
  [`docs/measurements.json`](https://github.com/csitte/mailwarden/blob/main/docs/measurements.json).
- **Reported to Google:** [issue 555806033](https://issuetracker.google.com/issues/555806033),
  filed 2026-09-02 against the Gmail API component and moved to **Assigned** the same day. See
  *Reported to Google* below — someone filed the same thing in 2018, and that one was closed
  unread.

## The finding

Gmail's search operators for read state (`is:unread`, `is:read`) are applied by the API to an
index. For `users.threads.list`, the value that index holds is a **thread-level** read state, and
that value can lag behind the mailbox. A thread whose every message has been read can still be
returned for `is:unread`, weeks after it was read.

The predicate is not being ignored. It is being applied to a copy of the truth that has not caught
up.

## How it was measured

For each query, every thread the index returned was fetched again and its **live labels** read. A
thread counts as stale when the index returned it for `is:unread` and none of its messages actually
carries the `UNREAD` label. That is the whole method: ask the index, then ask the mailbox about
each answer.

The mailbox is a private one of roughly 70,000 messages, in use for years. Two controls were run
alongside:

- **Is the predicate applied at all?** The same queries with `is:unread` removed return 800+
  threads, far more than the filtered result. The index is filtering; it is filtering on a stale
  value.
- **A second mailbox.** A business mailbox, measured identically on the same day, as a check on
  whether this is a property of Gmail or of a mailbox. See below.

## The numbers

Three queries through `threads.list`, each hit re-read for its true labels:

| Query | Threads returned | With an unread message | Stale |
|---|--:|--:|--:|
| `category:updates is:unread` | 131 | 17 | **87%** |
| `category:updates is:unread -in:inbox` | 128 | 14 | 89% |
| `is:unread -in:inbox` | 235 | 99 | 58% |

One returned thread carried a single label: `SENT`.

Read the third row before drawing a conclusion from the first two. The plainest query of the three
— one operator, no category, no negated container — shows the effect as well. Its share is the
*lowest* of the three (58%), and in absolute terms it is the *largest*: 136 threads that were not
unread.

## It is the thread index specifically

The follow-up, measured on 2026-08-16, asked the same query through both endpoints minutes apart:

| Endpoint | Hits | Stale |
|---|--:|--:|
| `users.threads.list` | 132 | 114 |
| `users.messages.list` | 19 | 0 |

(The thread figure is one higher than the evening before for the same query: a message arrived in
between. Both are correct for their moment; the point of this measurement is the contrast between
the two rows, not the absolute count.)

So the honest statement is not "Gmail search is unreliable". It is narrower and more useful: the
**thread-level** view of read state lags, while the per-message view does not. Code that resolves a
read-state query through `threads.list` inherits the lag. The same code asking `messages.list` does
not.

## A second mailbox did not drift at all

The business mailbox returned zero raw-index hits for `is:unread`, although it is read-marked
through the API many times a day. Drift there: none.

This is why the claim is "a property of *a* mailbox", not "a property of Gmail". It is also not a
counter-example to any particular cause, and should not be quoted as one: the two mailboxes differ
in volume by roughly three orders of magnitude and in age, and the second is missing something more
basic — no thread in it was ever archived while still unread, which is the only shape a stale
thread-level read state can show up on. It is not a mailbox that refutes the cause; it is a mailbox
without the candidate.

## What this is not

Three readings are tempting, and each is contradicted by the measurements above. They are listed
because we made two of them ourselves before the numbers were in.

- **"The index drops the `is:unread` predicate."** No. Removing the predicate from the same query
  returns 800+ threads instead of a few dozen, so it is being applied.
- **"It takes an exotic combination of operators."** No. The simplest of the three queries shows
  it, and shows it on more threads than either of the others.
- **"`is:unread` is unreliable in Gmail, generally."** Unsupported. The second mailbox contradicts
  it. What is supported is that a mailbox can be in this state, and that nothing in an API response
  tells you whether the one you are talking to is.

## Reproducing it

In your own mailbox — read-only, metadata only, printing counts and label names:

```bash
git clone https://github.com/csitte/mailwarden && cd mailwarden
npm install && npm run build
node scripts/probe-reverify.mjs
```

Without any Google account, against a fake Gmail API whose index is deliberately stale:

```bash
node scripts/demo-reverify.mjs
```

The demo asserts its outcome and exits non-zero if the behaviour it demonstrates ever stops
happening, so it doubles as a regression test.

## What it means for code that queries Gmail

A client cannot know in advance which kind of mailbox it is in. That is the operative consequence,
and it holds regardless of what any particular client does about it.

Two responses are available, and they cost differently:

- **Re-verify.** Fetch each hit and check the predicates against its live labels. Free where the
  fetch happens anyway, and it costs nothing where nothing drifts. This is what `mailwarden`'s
  `search` does: it re-checks the unambiguous predicates (`is:unread`, `is:read`, `is:starred`,
  `in:inbox`, `category:…`, with negation) and drops the false positives before any tool sees them.
  In the measurement above, every thread it dropped was genuinely read, and it discarded no
  genuinely unread mail.
- **Declare what was taken on trust.** For bulk paths sized in thousands of messages, one fetch per
  hit is a different order of cost. `mailwarden`'s `bulk_modify` therefore reports
  `unverifiedPredicates` — the conditions from the query that rest on the index's word — rather
  than implying silently that they were checked. A dry run does not close the gap: it re-reads the
  same index, so it confirms how large the set is, never whether it is right.

What neither response allows is treating the index's answer as the mailbox's state. Asked to
*"archive the unread promotional mail that already skips my inbox"*, an assistant reaches for
`category:updates is:unread -in:inbox` — the second row of the table above, where 89% of what came
back had already been read. Acting on that archives mail nobody meant to touch.

## Reported to Google

Filed on 2026-09-02 in the public issue tracker, Gmail API component, as
[issue 555806033](https://issuetracker.google.com/issues/555806033). The tracker moved it from
`New` to `Assigned` later the same day, so it is with a team rather than parked — which is worth
stating precisely: an assignment says the report was accepted as worth looking at, nothing yet
about a cause, a fix, or a timeline.

**It is not the first time.** A search of that component before filing turned up
[issue 78095953](https://issuetracker.google.com/issues/78095953), opened in April 2018. It
describes, in summary, a query with `label:unread` for which `threads.list` returns a message whose
labels do not include it — confirmed by fetching the message, and not reproduced by the web
interface, which returns nothing for the same query.

That is the behaviour described in this document, eight years earlier. It was closed as
**Can't Repro**, with no comments on it at all. The 2018 report named a suspected trigger — the
"Reply to" assist feature of the time — which may be why it could not be reproduced later: the
suspected cause aged out while the behaviour did not. A second report,
[36759403](https://issuetracker.google.com/issues/36759403) (`threadsUnread` exceeding
`threadsTotal` on a label), was also closed Can't Repro and may be another face of the same
thread-level counter.

What the new report adds is what the old one lacked: counts from a named date, a control query
showing the operator is applied at all, a second mailbox that does not exhibit it, and the endpoint
comparison. No claim about the cause.

Which is also the honest reading of the contrast in status. The 2018 report was closed without a
comment; this one was assigned within a day. The difference the evidence can account for is that
this report can be checked — it says what was measured, where, and how to repeat it. Whether that
is why it was assigned, nobody outside the tracker can say.

## Provenance

Every figure in this document is recorded in
[`docs/measurements.json`](https://github.com/csitte/mailwarden/blob/main/docs/measurements.json)
with its date, mailbox, endpoint and the session record it came from, and a test in that repository
fails if a figure appears in the prose that no recorded measurement accounts for. The reason for
that machinery is this document's own subject matter: two measurements one night apart had already
merged into a single date once, and both numbers were right while the label was not.
