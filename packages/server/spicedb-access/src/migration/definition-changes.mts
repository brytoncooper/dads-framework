import { createHash } from "node:crypto";

export type AuthorizationDefinitionPatch = {
  readonly name: string;
  readonly before: string | null;
  readonly after: string | null;
};

export type AuthorizationSchemaChange = {
  readonly id: string;
  readonly legacyHead: string;
  readonly dependsOn: readonly string[];
  readonly definitions: readonly AuthorizationDefinitionPatch[];
};

export type AuthorizationChangeErrorCode =
  | "AUTHZ_CHANGE_INVALID"
  | "AUTHZ_CHANGE_DEPENDENCY"
  | "AUTHZ_CHANGE_CONFLICT"
  | "AUTHZ_CHANGE_CHECKSUM"
  | "AUTHZ_CHANGE_HISTORY"
  | "AUTHZ_CHANGE_RELATIONSHIPS"
  | "AUTHZ_CHANGE_DRIFT";

export class AuthorizationChangeError extends Error {
  readonly code: AuthorizationChangeErrorCode;
  constructor(code: AuthorizationChangeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthorizationChangeError";
  }
}

export const AUTHORIZATION_CHANGE_ID = /^\d{14}_[a-f0-9]{8}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

const JOURNAL_TYPES = new Set(["authz/migration_journal", "authz/migration_version"]);

/** Canonical definitions absorb SpiceDB's formatting and equivalent permission grouping. */
export function authorizationSchemaDefinitions(schema: string): ReadonlyMap<string, string> {
  const tokens = schemaTokens(schema);
  const definitions = new Map<string, string>();
  let position = 0;
  while (position < tokens.length) {
    const start = position;
    const name = tokens[position + 1];
    if (
      tokens[position] !== "definition" ||
      name === undefined ||
      !/^[a-zA-Z_][a-zA-Z0-9_/]*$/.test(name) ||
      tokens[position + 2] !== "{"
    ) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        "authorization definition patches require complete definition blocks; unsupported schema syntax must be handled explicitly",
      );
    }
    position += 3;
    let depth = 1;
    while (position < tokens.length && depth > 0) {
      if (tokens[position] === "{") depth += 1;
      if (tokens[position] === "}") depth -= 1;
      position += 1;
    }
    if (depth !== 0 || definitions.has(name)) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization schema has an incomplete or duplicate definition ${name}`,
      );
    }
    definitions.set(name, canonicalDefinitionTokens(tokens.slice(start, position)).join(" "));
  }
  return definitions;
}

export function canonicalAuthorizationSchema(schema: string): string {
  return (
    [...authorizationSchemaDefinitions(schema)]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, definition]) => definition)
      .join("\n") + "\n"
  );
}

export function authorizationSchemaFingerprint(schema: string): string {
  return createHash("sha256").update(canonicalAuthorizationSchema(schema)).digest("hex");
}

export function applyAuthorizationDefinitionPatches(schema: string, change: AuthorizationSchemaChange): string {
  const definitions = new Map(authorizationSchemaDefinitions(schema));
  const touched = new Set<string>();
  for (const patch of change.definitions) {
    if (JOURNAL_TYPES.has(patch.name)) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${change.id} cannot alter journal definition ${patch.name}`,
      );
    }
    if (touched.has(patch.name) || (patch.before === null && patch.after === null)) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${change.id} has an invalid or repeated patch for ${patch.name}`,
      );
    }
    touched.add(patch.name);
    const before = canonicalPatchDefinition(patch.name, patch.before);
    const after = canonicalPatchDefinition(patch.name, patch.after);
    if ((definitions.get(patch.name) ?? null) !== before) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_CONFLICT",
        `authorization change ${change.id}: definition ${patch.name} differs from its prerequisite state; resolve this schema conflict and author the change against the required predecessor`,
      );
    }
    if (after === null) definitions.delete(patch.name);
    else definitions.set(patch.name, after);
  }
  return (
    [...definitions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, definition]) =>
        definition
          .replace(/\{\s*/g, "{\n")
          .replace(/\s*\}/g, "\n}")
          .replace(/\b(relation|permission)\b/g, "\n  $1"),
      )
      .join("\n") + "\n"
  );
}

/** Stable identities order only independent ready entries; prerequisites own causality. */
export function orderAuthorizationChanges<T extends AuthorizationSchemaChange>(
  changes: readonly T[],
  legacyHead: string,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const change of changes) {
    if (!AUTHORIZATION_CHANGE_ID.test(change.id) || byId.has(change.id)) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `invalid or duplicate authorization change id ${change.id}`,
      );
    }
    const date = new Date(
      `${change.id.slice(0, 4)}-${change.id.slice(4, 6)}-${change.id.slice(6, 8)}T${change.id.slice(8, 10)}:${change.id.slice(10, 12)}:${change.id.slice(12, 14)}Z`,
    );
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().replace(/[-:T]/g, "").slice(0, 14) !== change.id.slice(0, 14)
    )
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        `authorization change ${change.id} has an invalid UTC timestamp`,
      );
    if (
      change.legacyHead !== legacyHead ||
      change.dependsOn.length === 0 ||
      new Set(change.dependsOn).size !== change.dependsOn.length
    ) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_DEPENDENCY",
        `authorization change ${change.id} must declare its prerequisite frontier and immutable legacy head ${legacyHead}`,
      );
    }
    byId.set(change.id, change);
  }
  for (const change of changes) {
    for (const dependency of change.dependsOn) {
      if (dependency !== legacyHead && !byId.has(dependency)) {
        throw new AuthorizationChangeError(
          "AUTHZ_CHANGE_DEPENDENCY",
          `authorization change ${change.id} has missing prerequisite ${dependency}`,
        );
      }
    }
  }
  const ready = new Set([legacyHead]);
  const ordered: T[] = [];
  while (ordered.length < changes.length) {
    const next = changes
      .filter((change) => !ready.has(change.id) && change.dependsOn.every((dependency) => ready.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (next === undefined) {
      throw new AuthorizationChangeError("AUTHZ_CHANGE_DEPENDENCY", "authorization changes contain a dependency cycle");
    }
    ordered.push(next);
    ready.add(next.id);
  }
  return ordered;
}

export function composeAuthorizationChanges(baseline: string, ordered: readonly AuthorizationSchemaChange[]): string {
  return ordered.reduce(applyAuthorizationDefinitionPatches, baseline);
}

export function authorizationChangeFrontier(
  changes: readonly AuthorizationSchemaChange[],
  legacyHead: string,
): readonly string[] {
  const prerequisites = new Set(changes.flatMap((change) => change.dependsOn));
  const heads = changes
    .filter((change) => !prerequisites.has(change.id))
    .map((change) => change.id)
    .sort();
  return heads.length === 0 ? [legacyHead] : heads;
}

export function diffAuthorizationDefinitions(
  beforeSchema: string,
  afterSchema: string,
): readonly AuthorizationDefinitionPatch[] {
  const before = authorizationSchemaDefinitions(beforeSchema);
  const after = authorizationSchemaDefinitions(afterSchema);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((name) => {
    const previous = before.get(name) ?? null;
    const next = after.get(name) ?? null;
    return previous === next ? [] : [{ name, before: previous, after: next }];
  });
}

function canonicalPatchDefinition(name: string, schema: string | null): string | null {
  if (schema === null) return null;
  const definitions = authorizationSchemaDefinitions(schema);
  const definition = definitions.get(name);
  if (definitions.size !== 1 || definition === undefined) {
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_INVALID",
      `patch for ${name} must contain exactly its named definition`,
    );
  }
  return definition;
}

type PermissionOperator = "-" | "&" | "+";
type PermissionExpression =
  | { readonly kind: "atom"; readonly tokens: readonly string[] }
  | {
      readonly kind: "operation";
      readonly operator: PermissionOperator;
      readonly operands: readonly PermissionExpression[];
    };

function canonicalDefinitionTokens(tokens: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  let position = 0;
  while (position < tokens.length) {
    const token = tokens[position];
    if (token !== "permission") {
      if (token !== undefined) normalized.push(token);
      position += 1;
      continue;
    }
    const name = tokens[position + 1];
    if (name === undefined || tokens[position + 2] !== "=") throw expressionFailure();
    normalized.push("permission", name, "=");
    const start = position + 3;
    position = start;
    while (position < tokens.length && !["relation", "permission", "}"].includes(tokens[position] ?? "")) position += 1;
    normalized.push(canonicalPermissionExpression(tokens.slice(start, position)));
  }
  return normalized;
}

function canonicalPermissionExpression(tokens: readonly string[]): string {
  // SpiceDB binds union before intersection before exclusion.
  const precedence: readonly PermissionOperator[] = ["-", "&", "+"];
  let position = 0;

  function identifier(): string {
    const token = tokens[position];
    if (token === undefined || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) throw expressionFailure();
    position += 1;
    return token;
  }

  function consume(expected: string): void {
    if (tokens[position] !== expected) throw expressionFailure();
    position += 1;
  }

  function atom(): PermissionExpression {
    if (tokens[position] === "(") {
      position += 1;
      const nested = operation(0);
      consume(")");
      return nested;
    }
    const parts = [identifier()];
    while (tokens[position] === "->" || tokens[position] === ".") {
      const operator = tokens[position];
      position += 1;
      if (operator === "->") parts.push("->", identifier());
      else {
        const method = identifier();
        if (method !== "all" && method !== "any") throw expressionFailure();
        consume("(");
        const permission = identifier();
        consume(")");
        if (method === "any") parts.push("->", permission);
        else parts.push(".", "all", "(", permission, ")");
      }
    }
    return { kind: "atom", tokens: parts };
  }

  function operation(level: number): PermissionExpression {
    const operator = precedence[level];
    if (operator === undefined) return atom();
    let left = operation(level + 1);
    while (tokens[position] === operator) {
      position += 1;
      const right = operation(level + 1);
      left = {
        kind: "operation",
        operator,
        operands: [...associativeOperands(left, operator), ...associativeOperands(right, operator)],
      };
    }
    return left;
  }

  const expression = operation(0);
  if (position !== tokens.length) throw expressionFailure();
  return renderPermissionExpression(expression);
}

function associativeOperands(
  expression: PermissionExpression,
  operator: PermissionOperator,
): readonly PermissionExpression[] {
  return operator !== "-" && expression.kind === "operation" && expression.operator === operator
    ? expression.operands
    : [expression];
}

function renderPermissionExpression(expression: PermissionExpression): string {
  return expression.kind === "atom"
    ? expression.tokens.join(" ")
    : `( ${expression.operands.map(renderPermissionExpression).join(` ${expression.operator} `)} )`;
}

function expressionFailure(): AuthorizationChangeError {
  return new AuthorizationChangeError(
    "AUTHZ_CHANGE_INVALID",
    "authorization definition patches contain unsupported or malformed permission expression syntax",
  );
}

function schemaTokens(schema: string): readonly string[] {
  const tokens: string[] = [];
  let position = 0;
  while (position < schema.length) {
    const remaining = schema.slice(position);
    const whitespace = /^\s+/.exec(remaining)?.[0];
    if (whitespace !== undefined) {
      position += whitespace.length;
      continue;
    }
    if (remaining.startsWith("//")) {
      const end = remaining.indexOf("\n");
      position += end === -1 ? remaining.length : end + 1;
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end === -1)
        throw new AuthorizationChangeError("AUTHZ_CHANGE_INVALID", "authorization schema has an unterminated comment");
      position += end + 2;
      continue;
    }
    if (remaining.startsWith('"') || remaining.startsWith("'"))
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_INVALID",
        "authorization definition patches do not support quoted literals; add an exact literal parser before using this schema syntax",
      );
    const token = /^[a-zA-Z_][a-zA-Z0-9_/]*|^->|^./s.exec(remaining)?.[0];
    if (token === undefined)
      throw new AuthorizationChangeError("AUTHZ_CHANGE_INVALID", "authorization schema could not be tokenized");
    tokens.push(token);
    position += token.length;
  }
  return tokens;
}
