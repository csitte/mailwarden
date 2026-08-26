/**
 * Finds every sentence in this repository that ties "mailwarden does not send" to an OAuth
 * SCOPE, and requires each one to be a known, checked site.
 *
 * Why this exists. The project's central promise is that there is no way to send mail. The
 * precise version of it is: Google enforces that only in the `read` tier (`gmail.readonly`,
 * which the send endpoints reject); in `manage`/`filters` the token is `gmail.modify`, and
 * Google *does* accept that scope on `messages.send` — there the promise rests on the tool
 * surface and on the egress guard. Writing "the scopes cannot send" is therefore false for
 * every tier but one.
 *
 * That exact sentence has now been written twice and shipped twice: in six files at once
 * (found 2026-08-13, see docs/RELEASE-CHECKS.md) and again in the "next to a Workspace
 * server" section of 0.15.0 (found 2026-08-26 by csitte.at while mirroring it). Both times a
 * rule already existed in CLAUDE.md saying not to. A rule you have to remember is not a
 * control; this file is the control.
 *
 * How it works — deliberately the same shape as `src/egress.ts`: a wide net plus an explicit
 * list of known-good entries. A NEW sentence that mentions a scope and denies sending fails
 * the test until someone adds it to `ALLOWED` with a reason. Adding it is the moment they
 * read this comment. The point is not that the regexes judge the sentence correctly — they
 * cannot — but that no such sentence can appear without a human having looked at it once.
 *
 * The 2026-08-13 attempt failed because it grepped for particular wordings ("cannot send",
 * "scope.*send") and so missed `docs/SETUP.md`'s "neither grants a send capability" and
 * everything in German. Hence: match the *shape* of the claim (a scope word near a negated
 * send word), in both languages, and accept the false positives — they cost one allow-list
 * line each, once.
 *
 * What it does NOT claim to catch. The net wants a scope word and a negated send word close
 * together; an elliptical sentence slips past it, e.g. docs/SETUP.md's (correct) "gmail.modify
 * *is* a scope Gmail accepts for sending; mailwarden never does, because it registers no tool
 * that could" — "never does" carries no send word of its own. Widening the net far enough to
 * read that would drown the allow list in false positives. This is a net for the shapes that
 * have actually gone wrong here, not a proof that no overstatement exists.
 */

/** Something that names or implies an OAuth scope. */
export const SCOPE_ANCHOR =
  /gmail\.(readonly|modify|send|compose|settings\.basic)\b|mail\.google\.com|\bscopes?\b|\bgrants?\b|\bauthoriz\w+\b|\bberechtigt\b|\bScope-\w+/i;

/** A denial of sending, in either language, in either order. */
export const NO_SEND = new RegExp(
  // "cannot send", "no compose path", "never grants a send capability", …
  "\\b(no|not|never|cannot|can't|could not|couldn't|neither|nor|without|none|kein\\w*|nicht|nie|ohne)\\b" +
    "[^.]{0,80}?\\b(send\\w*|compose\\w*|senden|sendet|Versand)\\b" +
    "|" +
    // "sending is impossible", "senden ist ausgeschlossen"
    "\\b(send\\w*|compose\\w*|senden|sendet)\\b[^.]{0,40}?\\b(impossible|unmöglich|ausgeschlossen)\\b",
  "i",
);

/**
 * Does the sentence make the distinction that keeps the claim true — naming the tier, the
 * endpoint, the tool surface, or saying outright that `modify` does accept sending?
 *
 * This is a hint for the reader of a failure, never a pass: an unqualified sentence can still
 * be perfectly correct (a tool-surface claim that merely sits next to a scope word), and a
 * qualified one can still be wrong. Both go through `ALLOWED`.
 */
export const TIER_QUALIFIED =
  /\bread\b|\btier\b|\bmodify\s+(does|is|accepts|would)|\baccepts?\b|\benforce\w*\b|\bendpoint\b|\btool surface\b|\begress\b|\bTool-Oberfläche\b|\bTier\b/i;

/**
 * Split prose into sentence-ish units. Crude on purpose: it also breaks on markdown table
 * rows and list items, because a claim in a table cell has to be caught too, and a unit that
 * is too large would drag an unrelated qualifier in and hide the problem.
 */
export function splitSentences(text) {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z*`\-])|\n(?=[|\-*#])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Every scope-anchored no-send sentence in one file's text. */
export function findScopeAnchoredClaims(text) {
  return splitSentences(text)
    .filter((s) => SCOPE_ANCHOR.test(s) && NO_SEND.test(s))
    .map((sentence) => ({ sentence, qualified: TIER_QUALIFIED.test(sentence) }));
}

/**
 * The known sites. `excerpt` must appear verbatim in the sentence — so rewording a promise
 * breaks the test, which is the intent: a reworded promise is an unchecked promise.
 *
 * Before adding a line here, decide which of these the sentence is:
 *   - a TOOL claim ("there is no send tool") — always safe, tiers do not enter into it;
 *   - a `read`-tier claim ("gmail.readonly cannot send") — safe, Google enforces it;
 *   - a claim about `manage`/`filters` scopes — only safe if it says the promise rests on
 *     the tool surface and the egress guard, NOT on the scope.
 * If it is the third kind and does not say that, do not add it here. Fix the sentence.
 */
export const ALLOWED = [
  {
    file: "README.md",
    excerpt: "no send scope needed",
    why: "Tool claim about unsubscribe: RFC 8058 one-click needs no send scope, which is true in every tier. Says nothing about what the granted scopes could do.",
  },
  {
    file: "README.md",
    excerpt: "the only tier whose no-send property Google enforces",
    why: "The precise statement itself — names read as the only enforced tier.",
  },
  {
    file: "README.md",
    excerpt: "a `manage` one cannot send because there is nothing to call",
    why: "Explicitly grounds the manage tier in the tool surface, not the scope.",
  },
  {
    file: "README.md",
    excerpt: "the one scope in which no-send is enforced by Google rather than b",
    why: "Names gmail.readonly as the single Google-enforced case.",
  },
  {
    file: "SECURITY.md",
    excerpt: "which Google **does** accept on `messages.send`",
    why: "Threat model, states the manage-tier exception outright.",
  },
  {
    file: "SECURITY.md",
    excerpt: "There is no send-free write scope for an installed app",
    why: "A statement about Google's scope catalogue, not a promise that our scopes cannot send.",
  },
  {
    file: "CLAUDE.md",
    excerpt: "Nie wieder „die Scopes können nicht senden\" schreiben",
    why: "The rule itself, quoting the forbidden wording.",
  },
  {
    file: "CLAUDE.md",
    excerpt: "jede scope-verankerte No-Send-Aussage muss in einer Allowlist stehen",
    why: "Describes this very guard. Caught by it on the run right after it was written, which is the intended behaviour rather than an exception — it makes no claim about what a scope can do.",
  },
  {
    file: "docs/RELEASE-CHECKS.md",
    excerpt: "Achtung, hier stand bis 13.08.2026 etwas Falsches",
    why: "Records the 2026-08-13 incident, quoting the wrong sentence to warn about it.",
  },
  {
    file: "docs/RELEASE-CHECKS.md",
    excerpt: "die Aussage suchen, nicht die Formulierung",
    why: "Records why the first grep-based attempt missed files; quotes the patterns it used.",
  },
  {
    file: "src/auth.ts",
    excerpt: "The OAuth scopes to request are derived from the enabled tool tiers",
    why: "Describes scope derivation; the no-send words in range belong to the tier list, not to a promise.",
  },
  {
    file: "src/tiers.ts",
    excerpt: "The minimal OAuth scope set covering the enabled tiers",
    why: "Same: a description of which scopes are requested per tier.",
  },
  {
    file: "src/tiers.ts",
    excerpt: "By design there are NO compose/reply/forward/send tools",
    why: "Server instructions, a TOOL claim. Matches only because the scope sentence is concatenated in front of it.",
  },
];

/** A site is known when one allow-list entry for that file appears verbatim in the sentence. */
export function isAllowed(file, sentence) {
  return ALLOWED.some((a) => a.file === file && sentence.includes(a.excerpt));
}

/**
 * Claims with no allow-list entry, given `files` as `{ [path]: text }`.
 * Returns the offenders — an empty array is the passing state.
 */
export function unknownClaims(files) {
  const out = [];
  for (const [file, text] of Object.entries(files)) {
    for (const claim of findScopeAnchoredClaims(text)) {
      if (!isAllowed(file, claim.sentence)) out.push({ file, ...claim });
    }
  }
  return out;
}

/** Allow-list entries that no longer match anything — dead lines to remove. */
export function staleAllowances(files) {
  const seen = new Set();
  for (const [file, text] of Object.entries(files)) {
    for (const { sentence } of findScopeAnchoredClaims(text)) {
      for (const a of ALLOWED) {
        if (a.file === file && sentence.includes(a.excerpt)) seen.add(`${a.file}::${a.excerpt}`);
      }
    }
  }
  return ALLOWED.filter((a) => !seen.has(`${a.file}::${a.excerpt}`));
}
