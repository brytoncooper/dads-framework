import type { AccessIrDefinition, AccessIrPermission, AccessIrRole, AccessIrSubject, AccessIrTerm } from "./ir.js";

type PunctuationKind =
  | "arrow"
  | "plus"
  | "amp"
  | "minus"
  | "lparen"
  | "rparen"
  | "colon"
  | "pipe"
  | "star"
  | "hash"
  | "lbrace"
  | "rbrace"
  | "equals"
  | "dot";

type IdentToken = {
  readonly kind: "ident";
  readonly value: string;
  readonly line: number;
};

type Token = IdentToken | { readonly kind: PunctuationKind; readonly line: number };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith("/*") ? match.replace(/[^\n]/g, " ") : "",
  );
}

const punctuation = new Map<string, PunctuationKind>([
  ["+", "plus"],
  ["&", "amp"],
  ["-", "minus"],
  ["(", "lparen"],
  [")", "rparen"],
  [":", "colon"],
  ["|", "pipe"],
  ["*", "star"],
  ["#", "hash"],
  ["{", "lbrace"],
  ["}", "rbrace"],
  ["=", "equals"],
  ["->", "arrow"],
  [".", "dot"],
]);

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") count += 1;
  }
  return count;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let braceDepth = 0;
  for (const [text] of source.matchAll(/\s+|->|[A-Za-z][A-Za-z0-9_/]*|[^]/g)) {
    if (/^\s/.test(text)) {
      line += countNewlines(text);
      continue;
    }
    const kind = punctuation.get(text);
    if (kind !== undefined) {
      if (kind === "lbrace") braceDepth += 1;
      if (kind === "rbrace") braceDepth = Math.max(0, braceDepth - 1);
      tokens.push({ kind, line });
    } else if (/^[A-Za-z]/.test(text)) {
      if (braceDepth === 0 && text === "caveat") {
        throw new Error(`line ${line}: unsupported SpiceDB construct "caveat" in zed`);
      }
      tokens.push({ kind: "ident", value: text, line });
    } else {
      throw new Error(`line ${line}: unexpected character in zed: ${text}`);
    }
  }
  return tokens;
}

class ZedReader {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.position];
  }

  take(): Token {
    const token = this.tokens[this.position];
    if (token === undefined) {
      throw new Error("unexpected end of zed");
    }
    this.position += 1;
    return token;
  }

  eat(kind: Token["kind"]): Token {
    const token = this.take();
    if (token.kind !== kind) {
      throw new Error(`line ${token.line}: expected ${kind}, got ${token.kind}`);
    }
    return token;
  }

  eatIdentToken(expected?: string): IdentToken {
    const token = this.take();
    if (token.kind !== "ident") {
      throw new Error(`line ${token.line}: expected identifier, got ${token.kind}`);
    }
    if (expected !== undefined && token.value !== expected) {
      throw new Error(`line ${token.line}: expected ${expected}, got ${token.value}`);
    }
    return token;
  }

  eatIdent(expected?: string): string {
    return this.eatIdentToken(expected).value;
  }

  at(kind: Token["kind"]): boolean {
    return this.peek()?.kind === kind;
  }

  atIdent(value: string): boolean {
    const next = this.peek();
    return next?.kind === "ident" && next.value === value;
  }

  parseDocument(): AccessIrDefinition[] {
    const definitions: AccessIrDefinition[] = [];
    while (this.peek() !== undefined) {
      if (this.atIdent("use")) {
        this.parsePragma();
        continue;
      }
      if (this.atIdent("caveat")) {
        const token = this.take();
        throw new Error(`line ${token.line}: unsupported SpiceDB construct "caveat" in zed`);
      }
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  parsePragma(): void {
    this.eatIdent("use");
    const feature = this.eatIdentToken();
    if (feature.value !== "expiration") {
      throw new Error(`line ${feature.line}: unsupported pragma "use ${feature.value}" in zed`);
    }
  }

  parseDefinition(): AccessIrDefinition {
    this.eatIdent("definition");
    const wireName = this.eatIdent();
    this.eat("lbrace");
    const roles: AccessIrRole[] = [];
    const permissions: AccessIrPermission[] = [];
    while (!this.at("rbrace")) {
      const keyword = this.eatIdentToken();
      if (keyword.value === "relation") {
        roles.push(this.parseRelation());
        continue;
      }
      if (keyword.value === "permission") {
        permissions.push(this.parsePermission());
        continue;
      }
      throw new Error(`line ${keyword.line}: unexpected ${keyword.value} in definition ${wireName}`);
    }
    this.eat("rbrace");
    return { wireName, roles, permissions };
  }

  parseRelation(): AccessIrRole {
    const name = this.eatIdent();
    this.eat("colon");
    const subjects: AccessIrSubject[] = [this.parseSubject()];
    while (this.at("pipe")) {
      this.eat("pipe");
      subjects.push(this.parseSubject());
    }
    return { name, subjects };
  }

  parseBaseSubject(): AccessIrSubject {
    const wireName = this.eatIdent();
    if (this.at("colon")) {
      this.eat("colon");
      this.eat("star");
      return { kind: "wildcard", wireName };
    }
    if (this.at("hash")) {
      this.eat("hash");
      return { kind: "userset", wireName, relation: this.eatIdent() };
    }
    return { kind: "type", wireName };
  }

  parseSubject(): AccessIrSubject {
    const base = this.parseBaseSubject();
    if (!this.atIdent("with")) {
      return base;
    }
    const withToken = this.take();
    const qualifier = this.eatIdentToken();
    if (qualifier.value !== "expiration") {
      throw new Error(`line ${withToken.line}: unsupported caveat "with ${qualifier.value}" in zed`);
    }
    if (this.atIdent("and")) {
      const andToken = this.take();
      throw new Error(`line ${andToken.line}: unsupported caveat qualifier "and" in zed`);
    }
    return { ...base, expiration: true };
  }

  parsePermission(): AccessIrPermission {
    const name = this.eatIdent();
    this.eat("equals");
    return { name, terms: this.parseUnion() };
  }

  parseUnion(): AccessIrTerm[] {
    const terms = [this.parseIntersection()];
    while (this.at("plus")) {
      this.eat("plus");
      terms.push(this.parseIntersection());
    }
    return terms;
  }

  parseIntersection(): AccessIrTerm {
    let term = this.parseExclusion();
    while (this.at("amp")) {
      this.eat("amp");
      term = {
        kind: "both",
        left: term,
        right: this.parseExclusion(),
      };
    }
    return term;
  }

  parseExclusion(): AccessIrTerm {
    let term = this.parsePrimary();
    while (this.at("minus")) {
      this.eat("minus");
      term = {
        kind: "excluding",
        term,
        banned: this.parsePrimary(),
      };
    }
    return term;
  }

  parseParenthesized(): AccessIrTerm {
    const open = this.eat("lparen");
    const terms = this.parseUnion();
    this.eat("rparen");
    if (terms.length === 1) {
      const only = terms[0];
      if (only === undefined) {
        throw new Error(`line ${open.line}: empty parenthesized term`);
      }
      return only;
    }
    return { kind: "or", terms };
  }

  parseDotArrow(roleName: string): AccessIrTerm {
    this.eat("dot");
    const operator = this.eatIdentToken();
    if (operator.value !== "all" && operator.value !== "any") {
      throw new Error(`line ${operator.line}: unsupported arrow operator ".${operator.value}()" in zed`);
    }
    this.eat("lparen");
    const targetPermission = this.eatIdent();
    this.eat("rparen");
    return {
      kind: operator.value === "all" ? "through-all" : "through",
      roleName,
      targetPermission,
    };
  }

  parsePrimary(): AccessIrTerm {
    if (this.at("lparen")) {
      return this.parseParenthesized();
    }
    const token = this.eatIdentToken();
    if (token.value === "nil") {
      throw new Error(`line ${token.line}: unsupported SpiceDB construct "nil" in zed`);
    }
    if (this.at("arrow")) {
      this.eat("arrow");
      return {
        kind: "through",
        roleName: token.value,
        targetPermission: this.eatIdent(),
      };
    }
    if (this.at("dot")) {
      return this.parseDotArrow(token.value);
    }
    return { kind: "role", name: token.value };
  }
}

/**
 * Parse SpiceDB schema text into the same IR `emitAccessIr` produces.
 * Permission names that refer to another permission stay `role` — SpiceDB
 * uses one namespace for both, and compare treats those as equal.
 */
export function parseZed(source: string): readonly AccessIrDefinition[] {
  const tokens = tokenize(stripComments(source));
  return new ZedReader(tokens).parseDocument();
}
