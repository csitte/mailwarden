/**
 * Gmail's search syntax, evaluated against one message of the demo mailbox — pure, so a corpus
 * can hold it.
 *
 * This is NOT Gmail's search and does not pretend to be. It covers the operators mailwarden
 * itself builds and the ones a person tries first: free words and quoted phrases, `-` for not,
 * `OR`, `( )` to group and `{ }` for "any of"; `from:` `to:` `cc:` `bcc:` `subject:` `label:`
 * `in:` `is:` `has:` `category:` `filename:` `list:` `newer_than:` `older_than:` `after:`
 * `before:` `larger:` `smaller:` `rfc822msgid:` `deliveredto:`. An operator it does not know is
 * read as a free word, the way Gmail reads one it does not know. Matching is by case-insensitive
 * substring where Gmail matches whole words; in a mailbox of twenty threads written for this, the
 * difference does not show.
 */

/** What a query looks at in one message. */
export interface Searchable {
  /** The labels this view of the message carries — see `MessageView` in demo-api.ts. */
  labelIds: readonly string[];
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  listId: string;
  messageId: string;
  /** Body text and snippet, for free words. */
  text: string;
  filenames: readonly string[];
  /** Epoch milliseconds. */
  date: number;
  /** Bytes. */
  size: number;
}

/** What a query needs from the mailbox around the message. */
export interface QueryContext {
  now: number;
  /** The address `me` stands for. */
  self: string;
  /** Every label id whose name `label:` would match for this value. */
  labelIdsNamed: (name: string) => string[];
  /** Whether a label id is a user label (for `has:userlabels`). */
  isUserLabel: (id: string) => boolean;
}

type Node =
  | { kind: "and"; items: Node[] }
  | { kind: "or"; items: Node[] }
  | { kind: "not"; item: Node }
  | { kind: "term"; op?: string; value: string };

type Token = { t: "(" | ")" | "{" | "}" | "-" | "OR" } | { t: "word"; op?: string; value: string };

const KNOWN_OPS = new Set([
  "from", "to", "cc", "bcc", "subject", "label", "in", "is", "has", "category", "filename", "list",
  "newer_than", "older_than", "after", "before", "larger", "smaller", "rfc822msgid", "deliveredto",
]);

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const readQuoted = (): string => {
    // At an opening quote; an unclosed one runs to the end, as Gmail's does.
    const end = q.indexOf('"', i + 1);
    const s = q.slice(i + 1, end === -1 ? q.length : end);
    i = end === -1 ? q.length : end + 1;
    return s;
  };
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      out.push({ t: c });
      i++;
    } else if (c === "-" && i + 1 < q.length && !/\s/.test(q[i + 1])) {
      out.push({ t: "-" });
      i++;
    } else if (c === '"') {
      out.push({ t: "word", value: readQuoted() });
    } else {
      let j = i;
      while (j < q.length && !/[\s(){}"]/.test(q[j])) j++;
      const raw = q.slice(i, j);
      i = j;
      if (raw === "OR" || raw === "|") {
        out.push({ t: "OR" });
        continue;
      }
      const colon = raw.indexOf(":");
      const op = colon > 0 ? raw.slice(0, colon).toLowerCase() : undefined;
      if (op && KNOWN_OPS.has(op)) {
        let value = raw.slice(colon + 1);
        if (value === "" && q[i] === '"') value = readQuoted();
        out.push({ t: "word", op, value });
      } else {
        out.push({ t: "word", value: raw });
      }
    }
  }
  return out;
}

/** Parse a query. Never throws: a stray bracket is skipped, an empty query matches everything. */
export function parseQuery(q: string): Node {
  const toks = tokenize(q);
  let pos = 0;
  const peek = () => toks[pos];

  function parseOr(close?: ")" | "}"): Node {
    const items = [parseAnd(close)];
    while (peek()?.t === "OR") {
      pos++;
      items.push(parseAnd(close));
    }
    return items.length === 1 ? items[0] : { kind: "or", items };
  }
  function parseAnd(close?: ")" | "}"): Node {
    const items: Node[] = [];
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === "OR" || tok.t === close) break;
      if (tok.t === ")" || tok.t === "}") {
        pos++; // a closer with no opener: skipped
        continue;
      }
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0] : { kind: "and", items };
  }
  function parseUnary(): Node {
    const tok = toks[pos++];
    if (tok.t === "-") {
      if (!peek()) return { kind: "and", items: [] };
      return { kind: "not", item: parseUnary() };
    }
    if (tok.t === "(") {
      const inner = parseOr(")");
      if (peek()?.t === ")") pos++;
      return inner;
    }
    if (tok.t === "{") {
      const items: Node[] = [];
      while (peek() && peek().t !== "}") {
        if (peek().t === "OR") {
          pos++;
          continue;
        }
        items.push(parseUnary());
      }
      if (peek()?.t === "}") pos++;
      return { kind: "or", items };
    }
    if (tok.t === "word") return { kind: "term", op: tok.op, value: tok.value };
    return { kind: "and", items: [] }; // `)` `}` `OR` cannot reach here; an empty AND matches all
  }
  return parseOr();
}

const CATEGORY: Record<string, string> = {
  primary: "CATEGORY_PERSONAL",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};
const IN: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  trash: "TRASH",
  spam: "SPAM",
  drafts: "DRAFT",
  draft: "DRAFT",
  starred: "STARRED",
  important: "IMPORTANT",
};
const DAY = 86_400_000;

function parseDate(v: string): number | undefined {
  if (/^\d{9,}$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}
function parseAge(v: string): number | undefined {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n * (m[2].toLowerCase() === "d" ? DAY : m[2].toLowerCase() === "m" ? 30 * DAY : 365 * DAY);
}
function parseSize(v: string): number | undefined {
  const m = /^(\d+)([km]?)b?$/i.exec(v);
  if (!m) return undefined;
  const unit = m[2].toLowerCase();
  return Number(m[1]) * (unit === "k" ? 1024 : unit === "m" ? 1024 * 1024 : 1);
}

function includes(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function termMatches(op: string | undefined, value: string, m: Searchable, ctx: QueryContext): boolean {
  const has = (id: string) => m.labelIds.includes(id);
  const v = value.toLowerCase();
  const person = (field: string) => (v === "me" ? includes(field, ctx.self) : includes(field, value));
  switch (op) {
    case undefined:
      return v === "" || [m.subject, m.from, m.to, m.cc, m.text, ...m.filenames].some((f) => includes(f, value));
    case "from":
      return person(m.from);
    case "to":
    case "deliveredto":
      return person(m.to);
    case "cc":
      return person(m.cc);
    case "bcc":
      return person(m.bcc);
    case "subject":
      return includes(m.subject, value);
    case "label":
      return ctx.labelIdsNamed(value).some(has);
    case "in":
      if (v === "anywhere") return true;
      return IN[v] !== undefined && has(IN[v]);
    case "is":
      if (v === "unread") return has("UNREAD");
      if (v === "read") return !has("UNREAD");
      if (v === "starred") return has("STARRED");
      if (v === "unstarred") return !has("STARRED");
      if (v === "important") return has("IMPORTANT");
      if (v === "unimportant") return !has("IMPORTANT");
      return false; // snoozed, muted, chat: the demo has none
    case "has":
      if (v === "attachment") return m.filenames.length > 0;
      if (v === "userlabels") return m.labelIds.some(ctx.isUserLabel);
      if (v === "nouserlabels") return !m.labelIds.some(ctx.isUserLabel);
      return false;
    case "category":
      return CATEGORY[v] !== undefined && has(CATEGORY[v]);
    case "filename":
      return m.filenames.some((f) => includes(f, value));
    case "list":
      return includes(m.listId, value);
    case "rfc822msgid":
      return includes(m.messageId, value);
    case "newer_than":
    case "older_than": {
      const age = parseAge(value);
      if (age === undefined) return false;
      return op === "newer_than" ? m.date > ctx.now - age : m.date < ctx.now - age;
    }
    case "after":
    case "before": {
      const at = parseDate(value);
      if (at === undefined) return false;
      return op === "after" ? m.date >= at : m.date < at;
    }
    case "larger":
    case "smaller": {
      const size = parseSize(value);
      if (size === undefined) return false;
      return op === "larger" ? m.size > size : m.size < size;
    }
    default:
      return includes([m.subject, m.from, m.text].join(" "), `${op}:${value}`);
  }
}

function evaluate(n: Node, m: Searchable, ctx: QueryContext): boolean {
  switch (n.kind) {
    case "and":
      return n.items.every((i) => evaluate(i, m, ctx));
    case "or":
      return n.items.some((i) => evaluate(i, m, ctx));
    case "not":
      return !evaluate(n.item, m, ctx);
    case "term":
      return termMatches(n.op, n.value, m, ctx);
  }
}

/** Whether `m` matches query `q`. */
export function matchesQuery(q: string, m: Searchable, ctx: QueryContext): boolean {
  return evaluate(parseQuery(q), m, ctx);
}

/**
 * Whether the query itself asks for trash or spam. Gmail leaves both out of every search unless
 * the query names them (or `in:anywhere`); the demo follows that, the way `search` documents it.
 */
export function asksForTrashOrSpam(q: string): boolean {
  return /(?:^|[\s({])(?:in|label):(?:trash|spam|anywhere)\b/i.test(q);
}
