---
title: "87% of what Gmail's search index called unread had already been read"
published: false
description: "I shipped a claim about Gmail's search index for eight weeks without measuring it. When I finally did, the effect was real, my explanation was wrong, and a second mailbox disagreed with both."
tags: gmail, api, testing, mcp
---

For eight weeks my project's README told people this:

> Gmail's `threads.list` index silently drops `is:unread` in some operator combinations.

It is a confident sentence. It has a mechanism, a scope, and the word *silently*, which is the sort of word that makes a reader nod. It came from a real symptom someone hit once, in June, and it went into a commit message, and from there into the README, the threat model, the website, and the source comments.

Nobody ever measured it.

Last week someone asked me to verify it before repeating it in public. This is what happened, in order, including the part where I was wrong.

## The thing that made it measurable

The project is [mailwarden](https://github.com/csitte/mailwarden), a Gmail MCP server — the layer an AI assistant talks to when you ask it to triage your mailbox. One of its features exists *because* of the claim above: every search hit is re-checked against the thread's live labels, and hits that contradict the query are dropped before any tool sees them.

That feature is also what makes the claim hard to check from the outside: the server hides the very thing I wanted to look at. If Gmail hands back a read thread for an `is:unread` query, mailwarden drops it, and the caller never learns it existed.

There is a way through, and it falls out of a rule written for a completely different reason. The post-filter refuses to touch queries it cannot safely reason about — anything with `OR`, quotes, or parentheses is passed through untouched, so a user's boolean logic is never quietly rewritten. Which means:

```
search("category:updates is:unread")     → re-verified result
search("(category:updates is:unread)")   → raw index result
```

Gmail treats the two identically. My own code does not. Verified before trusting it: `(category:updates)` and `category:updates` return the same 69 threads in a test account, and in the real measurement both forms came back with identical `nextPageToken`s — same upstream stream, one filtered, one not.

The difference between those two numbers is exactly what the index got wrong.

## Attempt one: nothing to see

The first mailbox I reached had no unread mail at all — `is:unread` returned 0 across the whole account. So `category:updates is:unread -in:inbox` returned 0 too, while 69 `category:updates` threads sat right there.

Tempting reading: *the index is fine, the claim is bunk.* That reading is wrong, and noticing why mattered more than the number. If the index's failure mode is "returns read mail **in addition to** unread mail", then a mailbox with zero unread mail produces zero hits whether the index is perfect or hopeless. A negative result from an empty sample is not evidence. It is an empty sample.

So the honest write-up of run one was: **inconclusive**, and that is what went into the changelog.

## Attempt two: a mailbox with ~70,000 messages

The second mailbox had what the first lacked: mail that is unread *and* archived. Not because anyone engineered it — because its owner swipes mail away in the Gmail app without opening it, which is what most people do.

All read-only, both forms of each query, fully paginated:

| Query | Index hits | Genuinely unread | False positives |
|---|--:|--:|--:|
| `category:updates is:unread` | 131 | 17 | **87%** |
| `category:updates is:unread -in:inbox` | 128 | 14 | **89%** |
| `is:unread -in:inbox` | 235 | 99 | **58%** |

The effect is real, and it is not subtle. Ask Gmail for unread mail in a category and seven out of eight answers can be mail you read weeks ago.

Two details from that run are worth more than the headline number:

- The difference set was exactly the threads lacking the `UNREAD` label. The arithmetic closes: 131 − 114 = 17. Nothing unexplained.
- One returned thread carried exactly one label: `SENT`. Gmail offered me a message I had sent myself as a candidate for "unread mail that is not in my inbox".

And the number that matters if you are on the receiving end of an automated cleanup: the re-verification dropped **no** genuinely unread mail. Every thread it discarded was really read.

## My explanation was wrong

Here is the control I should have run in June. Take the query and remove the predicate under suspicion:

```
(category:updates is:unread)   →  131 threads
(category:updates)             →  800+ threads (stopped counting at 8 pages)
```

If the index were *dropping* `is:unread`, both would return the same set. They differ by a factor of six. **The predicate is being applied.** It is being applied against a copy of the read state that has not caught up with the mailbox — mail read weeks ago still counts as unread *in the index*, while the thread's actual labels say otherwise.

Same symptom, different mechanism, and the difference is not academic:

- "Silently drops the predicate" implies an operator-parsing quirk you could dodge by rephrasing the query.
- "Stale read state" says rephrasing will not save you, because the index's *data* is behind, not its *logic*.

The second explanation also survives the evidence better. The largest drift I measured was on the simplest query, `is:unread -in:inbox` — not on the three-operator combination the README had been holding up as the example for two months. The "certain operator combinations" part of my sentence was as unfounded as the "drops" part. I had generalised a single observation into a mechanism, twice, in one sentence.

## Then a second mailbox disagreed with my correction

I was about to write "Gmail's index answers `is:unread` from a stale read state" — a nice, quotable, general claim. Before I could, the small mailbox from attempt one was measured properly as a control:

| Mailbox | Volume | Read state changed by | Drift |
|---|--:|---|--:|
| personal, years old | ~70,000 messages | app swipes **and** API | **87% / 58%** |
| business, weeks old | ~100 messages | API only | **0** |

Zero. Not "less". In an account where `UNREAD` is removed through the API many times a day, including 70 minutes before the measurement, the raw index returned **no** stale hits at all.

So the general claim was wrong too, and it was wrong in the same way as the original: taking one mailbox for the world. What is actually established is narrower:

- A mailbox **can** answer `is:unread` from a stale read state, badly enough that most results are wrong.
- Another mailbox, measured identically the same day, does not.
- Where it happens, it is not tied to any particular operator combination.

The two mailboxes differ in at least four ways: volume (roughly three orders of magnitude), account age, how long since the last read-state change, and whether that change came from the Gmail app or from the API. The last one is the interesting suspect — and it is a **suspect**, not a finding. Distinguishing them properly would mean flipping a message's read state purely to watch the index, in someone's real mailbox, which is a measurement I decided not to make.

## What this is worth to you

If you write anything that acts on Gmail search results — a cleanup script, an agent, a rule engine — the practical rule does not depend on which mailbox you are in, which is precisely the point: **you cannot tell from inside.** So:

**Do not act on the index's read state. Check the thread's labels.**

The cost is asymmetric to the point of being a non-decision. If you are fetching the threads anyway, the labels arrive in the same response and the check is free. Where nothing drifts, it costs nothing and changes nothing. Where something drifts, it is the difference between archiving 17 threads and archiving 131 — 114 of which you had read and expected to stay where they were.

That asymmetry is the actual takeaway, and it survives every uncertainty above. I do not know why one mailbox drifts and another does not. I do not need to.

## Measure it in your own mailbox

Both are in the repo, neither needs my mailbox:

```bash
git clone https://github.com/csitte/mailwarden && cd mailwarden
npm install && npm run build

node scripts/demo-reverify.mjs     # no account needed: fake API, asserts the behaviour
node scripts/probe-reverify.mjs    # your mailbox: read-only, metadata only, prints counts
```

The probe reads label ids and nothing else — no subjects, no senders, no bodies — and prints counts and label names. If it reports zero for you, that is a real result about your mailbox, and it is the same result the business account gave. Please tell me if you find a mailbox where the drift shows and read state has *only ever* been changed through the API. That is the measurement that would kill my current suspicion, and killing it is worth more to me than keeping it.

## The part I actually want to keep

The bug in my documentation was never the sentence. It was that a sentence with a mechanism in it had a lower evidentiary bar than the code it justified. The code had tests. The claim about someone else's system — the claim that *explained* the code, the one people would quote back at me — had a commit message from June.

Eight weeks is how long it took for anyone to ask "how do you know?". The answer took an afternoon.

---

*mailwarden is a Gmail MCP server that deliberately cannot send mail — [github.com/csitte/mailwarden](https://github.com/csitte/mailwarden), MIT. The measurements above were run against two real Gmail accounts on 15 August 2026, read-only; mailbox sizes are given as orders of magnitude on purpose, every measured result is exact. The same numbers and caveats are in the project's [CHANGELOG](https://github.com/csitte/mailwarden/blob/main/CHANGELOG.md).*
