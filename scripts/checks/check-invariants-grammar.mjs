/**
 * The grammar of an `INVARIANTS.md` entry, read off the eighteen files that
 * already exist rather than off a template.
 *
 *     entry    := "- " id ": " statement "enforced by" prose
 *                 [ ("," | ";") "proven by" prose ]
 *     id       := "INV-" upper-case word ("-" upper-case word)*
 *
 * Both clauses are prose, and the prose varies: "enforced by X and Y", "the
 * catch block of X", "X (its Y and Z)", "X through Y". Nothing useful is
 * gained by parsing English, so the clause is scanned left to right for the
 * two things a citation is ever written as — a backticked span and a
 * double-quoted span — and each one is classified:
 *
 * | Token in the clause          | Citation                                  |
 * | ---------------------------- | ----------------------------------------- |
 * | `<path>`                     | that file exists; becomes the anchor       |
 * | `<path>#<symbol>`            | the file, and `symbol` declared in it      |
 * | `#<symbol>`                  | `symbol` declared in the anchor            |
 * | `<name>`                     | `name` declared in the anchor (enforced clause only) |
 * | `"<test name>"`              | a test of that name in the anchor (proven clause only) |
 * | anything else in backticks   | prose — `401 BODY_TOO_LARGE`, `npm run verify:http` |
 *
 * A `<symbol>` after a `#` may be a member, written `Owner.member` or
 * `Owner#member`: the `#` is what marks the span as a citation, so the dotted
 * form is unambiguous there. A *bare* dotted span is not a citation — it is
 * prose reaching into a value, `process.stderr` or `composition.client`, and
 * a member the entry means to cite is written with the `#`.
 *
 * A backticked span is a path when it ends in a source extension and carries
 * no whitespace. The anchor is the last file named in the same clause, which
 * is what makes the continuation forms (`#executeRoute`, `(its `resolver`)`)
 * mean what a reader takes them to mean.
 *
 * Bare identifiers are citations in the `enforced by` clause only. In a
 * `proven by` clause the same shape is prose about the test — "(targets
 * `watch` and `lint`)", "asserts on the injected `clock`" — and reading it as
 * a symbol would fail every entry that explains itself.
 *
 * Two structural rules, held for every entry: an `enforced by` clause is
 * required and must name at least one file, and a `proven by` clause is
 * optional but must name a file when it is written. An entry that carries
 * neither an id nor a clause is a parse failure that names the file, the
 * entry, and the text — never a silent skip.
 */

const ENTRY_PATTERN = /^-\s+(INV-[A-Z0-9]+(?:-[A-Z0-9]+)*):\s+(.+)$/s;
const BULLET_PATTERN = /^-\s+(.*)$/;
const ENFORCED_BY = "enforced by";
const PROVEN_BY = "proven by";
const TOKEN_PATTERN = /`([^`\n]+)`|"([^"\n]+)"/g;
const SYMBOL_TEXT = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)?$/;
const BARE_SYMBOL_TEXT = /^[A-Za-z_$][\w$]*$/;
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "json",
  "toml",
  "md",
  "yml",
  "yaml",
];
const PATH_PATTERN = new RegExp(`^[\\w@./-]+\\.(?:${SOURCE_EXTENSIONS.join("|")})$`);

/**
 * Every bullet in the file, with the continuation lines an entry wraps onto
 * folded back into one line. A wrapped bullet is still one entry, so folding
 * happens before anything is decided about it.
 */
export function readBullets(text) {
  const bullets = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (BULLET_PATTERN.test(line)) {
      bullets.push({ line: index + 1, text: line });
      continue;
    }
    const open = bullets.at(-1);
    const continues = open !== undefined && /^\s+\S/.test(line);
    if (continues && open.line + countLines(open.text) === index + 1) {
      open.text = `${open.text}\n${line}`;
    }
  }
  return bullets;
}

function countLines(text) {
  return text.split("\n").length;
}

/** The `enforced by` and `proven by` clauses, or the reason there are none. */
export function splitClauses(body) {
  const enforcedStart = body.indexOf(ENFORCED_BY);
  if (enforcedStart === -1) {
    return { problem: `carries no "${ENFORCED_BY}" clause` };
  }
  const tail = body.slice(enforcedStart + ENFORCED_BY.length);
  const provenStart = tail.indexOf(PROVEN_BY);
  if (provenStart === -1) return { enforced: tail };
  return {
    enforced: tail.slice(0, provenStart),
    proven: tail.slice(provenStart + PROVEN_BY.length),
  };
}

/**
 * The citations a clause carries, in the order they are written. `bareSymbols`
 * is on for `enforced by` and off for `proven by`; see the table above.
 */
export function readCitations(clause, { bareSymbols }) {
  const citations = [];
  let anchor;
  for (const token of scanTokens(clause)) {
    if (token.quoted) {
      if (anchor !== undefined) {
        citations.push({ kind: "test", path: anchor, name: token.text });
      }
      continue;
    }
    const file = matchPath(token.text);
    if (file !== undefined) {
      anchor = file.path;
      citations.push({ kind: "file", path: file.path });
      if (file.symbol !== undefined) {
        citations.push({ kind: "symbol", path: anchor, symbol: file.symbol });
      }
      continue;
    }
    const symbol = matchSymbol(token.text, bareSymbols);
    if (symbol !== undefined && anchor !== undefined) {
      citations.push({ kind: "symbol", path: anchor, symbol });
    }
  }
  return citations;
}

function* scanTokens(clause) {
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(clause);
  while (match !== null) {
    const [, code, quoted] = match;
    yield code === undefined ? { quoted: true, text: quoted } : { quoted: false, text: code };
    match = TOKEN_PATTERN.exec(clause);
  }
}

/** `<path>` or `<path>#<symbol>`, or `undefined` when the span is not a path. */
function matchPath(text) {
  const hash = text.indexOf("#");
  const path = hash === -1 ? text : text.slice(0, hash);
  if (!PATH_PATTERN.test(path)) return undefined;
  const symbol = hash === -1 ? undefined : text.slice(hash + 1);
  if (symbol !== undefined && !SYMBOL_TEXT.test(symbol)) return undefined;
  return { path, symbol };
}

/** `#name`, or a bare undotted `name` where the clause allows one. */
function matchSymbol(text, bareSymbols) {
  if (text.startsWith("#")) {
    const symbol = text.slice(1);
    return SYMBOL_TEXT.test(symbol) ? symbol : undefined;
  }
  if (!bareSymbols) return undefined;
  return BARE_SYMBOL_TEXT.test(text) ? text : undefined;
}

/**
 * Every entry in one file, and every bullet that is not one. `problems` are
 * phrased to follow `<file>: `; each names the entry or the text it read.
 */
export function parseInvariants(file, text) {
  const entries = [];
  const problems = [];
  for (const bullet of readBullets(text)) {
    const parsed = ENTRY_PATTERN.exec(bullet.text);
    if (parsed === null) {
      problems.push(`line ${bullet.line}: ${notAnEntry(bullet.text)}`);
      continue;
    }
    const [, id, body] = parsed;
    const entry = readEntry(id, body, bullet.line);
    if (entry.problem !== undefined) {
      problems.push(`${id}: ${entry.problem}`);
      continue;
    }
    entries.push(entry.entry);
  }
  return { entries, problems };
}

function readEntry(id, body, line) {
  const clauses = splitClauses(body);
  if (clauses.problem !== undefined) return { problem: clauses.problem };

  const enforced = readCitations(clauses.enforced, { bareSymbols: true });
  if (!enforced.some((citation) => citation.kind === "file")) {
    return { problem: `"${ENFORCED_BY}" names no file` };
  }
  const proven = clauses.proven === undefined ? [] : readCitations(clauses.proven, { bareSymbols: false });
  if (clauses.proven !== undefined && !proven.some((c) => c.kind === "file")) {
    return { problem: `"${PROVEN_BY}" names no file` };
  }
  return { entry: { id, line, citations: [...enforced, ...proven] } };
}

function notAnEntry(text) {
  const single = text.replace(/\s+/g, " ").trim();
  const shown = single.length > 90 ? `${single.slice(0, 90)}...` : single;
  return `bullet is not an invariant entry (no "INV-<NAME>-<n>:" id): ${shown}`;
}
