import type { AccessIrDefinition } from "./ir.js";

const JS_RESERVED_WORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const ERGONOMIC_RESERVED_IDENTIFIERS = new Set([
  ...JS_RESERVED_WORDS,
  "access",
  "actor",
  "allOf",
  "anyOf",
  "compileAccess",
  "every",
  "permissionToken",
  "resource",
]);

export type ErgonomicSymbols = {
  readonly allWireNames: readonly string[];
  readonly varByWireName: ReadonlyMap<string, string>;
  readonly definitionByWireName: ReadonlyMap<string, AccessIrDefinition>;
  readonly actorWireNames: ReadonlySet<string>;
};

export function toCamelCase(wireName: string): string {
  const parts = wireName
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "entity";
  const [first = "entity", ...rest] = parts;
  const head = first.toLowerCase();
  const tail = rest.map((part) => {
    const firstChar = part[0] ?? "";
    return `${firstChar.toUpperCase()}${part.slice(1).toLowerCase()}`;
  });
  const combined = `${head}${tail.join("")}`;
  return /^[0-9]/.test(combined) ? `entity${combined}` : combined;
}

function allocateUnique(
  preferred: string,
  used: Set<string>,
  reserved: ReadonlySet<string>,
  reservedSuffix: string,
): string {
  const base = reserved.has(preferred)
    ? `${preferred}${reservedSuffix}`
    : preferred;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}_${index}`)) {
    index += 1;
  }
  const candidate = `${base}_${index}`;
  used.add(candidate);
  return candidate;
}

function collectWireNames(
  definitions: readonly AccessIrDefinition[],
): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (wireName: string): void => {
    if (seen.has(wireName)) return;
    seen.add(wireName);
    ordered.push(wireName);
  };
  for (const definition of definitions) {
    add(definition.wireName);
  }
  for (const definition of definitions) {
    for (const role of definition.roles) {
      for (const subject of role.subjects) add(subject.wireName);
    }
  }
  return ordered;
}

export function allocateErgonomicSymbols(
  definitions: readonly AccessIrDefinition[],
): ErgonomicSymbols {
  const allWireNames = collectWireNames(definitions);
  const used = new Set<string>(ERGONOMIC_RESERVED_IDENTIFIERS);
  const varByWireName = new Map<string, string>();
  const definitionByWireName = new Map<string, AccessIrDefinition>();
  const actorWireNames = new Set<string>();

  for (const definition of definitions) {
    definitionByWireName.set(definition.wireName, definition);
  }
  for (const wireName of allWireNames) {
    const variable = allocateUnique(
      toCamelCase(wireName),
      used,
      ERGONOMIC_RESERVED_IDENTIFIERS,
      "Entity",
    );
    varByWireName.set(wireName, variable);
    const definition = definitionByWireName.get(wireName);
    if (
      definition === undefined ||
      (definition.roles.length === 0 && definition.permissions.length === 0)
    ) {
      actorWireNames.add(wireName);
    }
  }

  return {
    allWireNames,
    varByWireName,
    definitionByWireName,
    actorWireNames,
  };
}

function resourceSubjectDependencies(
  definition: AccessIrDefinition,
  resourceWireNames: ReadonlySet<string>,
): readonly string[] {
  const deps: string[] = [];
  for (const role of definition.roles) {
    for (const subject of role.subjects) {
      if (
        subject.wireName !== definition.wireName &&
        resourceWireNames.has(subject.wireName)
      ) {
        deps.push(subject.wireName);
      }
    }
  }
  return deps;
}

/**
 * Order non-actor resource definitions so non-cyclic referenced resources
 * are declared before resources that reference them.
 */
export function orderErgonomicResources(
  definitions: readonly AccessIrDefinition[],
  actorWireNames: ReadonlySet<string>,
): readonly AccessIrDefinition[] {
  const resources = definitions.filter(
    (definition) => !actorWireNames.has(definition.wireName),
  );
  const byName = new Map(resources.map((def) => [def.wireName, def]));
  const resourceNames = new Set(byName.keys());
  const visited = new Set<string>();
  const ordered: AccessIrDefinition[] = [];

  const visit = (wireName: string): void => {
    if (visited.has(wireName)) return;
    visited.add(wireName);
    const definition = byName.get(wireName);
    if (definition === undefined) return;
    for (const dep of resourceSubjectDependencies(definition, resourceNames)) {
      visit(dep);
    }
    ordered.push(definition);
  };

  for (const definition of resources) {
    visit(definition.wireName);
  }
  return ordered;
}

export function isJsReservedWord(name: string): boolean {
  return JS_RESERVED_WORDS.has(name);
}

export function isValidJsIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

export function formatPropKey(name: string): string {
  return isValidJsIdentifier(name) ? name : JSON.stringify(name);
}

export function formatPropAccess(target: string, name: string): string {
  return isValidJsIdentifier(name)
    ? `${target}.${name}`
    : `${target}[${JSON.stringify(name)}]`;
}
