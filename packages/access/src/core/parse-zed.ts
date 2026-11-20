import type {
  AccessIrDefinition,
  AccessIrPermission,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./ir.js";

type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "arrow" }
  | { readonly kind: "plus" }
  | { readonly kind: "amp" }
  | { readonly kind: "minus" }
  | { readonly kind: "lparen" }
  | { readonly kind: "rparen" }
  | { readonly kind: "colon" }
  | { readonly kind: "pipe" }
  | { readonly kind: "star" }
  | { readonly kind: "hash" }
  | { readonly kind: "lbrace" }
  | { readonly kind: "rbrace" }
  | { readonly kind: "equals" };

function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

const punctuation = new Map<string, Token["kind"]>([
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
]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (const [text] of source.matchAll(/\s+|->|[A-Za-z][A-Za-z0-9_/]*|[^]/g)) {
    if (/^\s/.test(text)) continue;
    const kind = punctuation.get(text);
    if (kind !== undefined && kind !== "ident") {
      tokens.push({ kind });
    } else if (/^[A-Za-z]/.test(text)) {
      tokens.push({ kind: "ident", value: text });
    } else {
      throw new Error(`unexpected character in zed: ${text}`);
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
      throw new Error(`expected ${kind}, got ${token.kind}`);
    }
    return token;
  }

  eatIdent(expected?: string): string {
    const token = this.take();
    if (token.kind !== "ident") {
      throw new Error(`expected identifier, got ${token.kind}`);
    }
    if (expected !== undefined && token.value !== expected) {
      throw new Error(`expected ${expected}, got ${token.value}`);
    }
    return token.value;
  }

  at(kind: Token["kind"]): boolean {
    return this.peek()?.kind === kind;
  }

  parseDocument(): AccessIrDefinition[] {
    const definitions: AccessIrDefinition[] = [];
    while (this.peek() !== undefined) {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  parseDefinition(): AccessIrDefinition {
    this.eatIdent("definition");
    const wireName = this.eatIdent();
    this.eat("lbrace");
    const roles: AccessIrRole[] = [];
    const permissions: AccessIrPermission[] = [];
    while (!this.at("rbrace")) {
      const keyword = this.eatIdent();
      if (keyword === "relation") {
        roles.push(this.parseRelation());
        continue;
      }
      if (keyword === "permission") {
        permissions.push(this.parsePermission());
        continue;
      }
      throw new Error(`unexpected ${keyword} in definition ${wireName}`);
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

  parseSubject(): AccessIrSubject {
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

  parsePrimary(): AccessIrTerm {
    if (this.at("lparen")) {
      this.eat("lparen");
      const terms = this.parseUnion();
      this.eat("rparen");
      if (terms.length === 1) {
        const only = terms[0];
        if (only === undefined) {
          throw new Error("empty parenthesized term");
        }
        return only;
      }
      return { kind: "or", terms };
    }
    const name = this.eatIdent();
    if (this.at("arrow")) {
      this.eat("arrow");
      return {
        kind: "through",
        roleName: name,
        targetPermission: this.eatIdent(),
      };
    }
    return { kind: "role", name };
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
