import { parseZedDefinitions } from "../logic/classify-schema-diff.js";

/**
 * Author a temporary snapshot accepting old facts while replacements are copied.
 * Only storage shapes are expanded; all permission expressions come from nextSchema.
 * Removed definitions and relation/permission collisions require an explicitly authored bridge.
 */
export function buildMigrationBridgeSchema(previousSchema: string, nextSchema: string): string {
  const previous = parseZedDefinitions(previousSchema);
  const next = parseZedDefinitions(nextSchema);
  requireRetainedDefinitions(previous, next);
  const bridge = new MigrationBridgeWriter(previous);
  for (const line of nextSchema.split("\n")) bridge.append(line);
  return bridge.output.join("\n");
}

type Definitions = ReturnType<typeof parseZedDefinitions>;
type DefinitionStorage = {
  readonly name: string;
  readonly oldRelations: ReadonlyMap<string, readonly string[]>;
  readonly seenRelations: Set<string>;
  readonly permissions: Set<string>;
};

function requireRetainedDefinitions(previous: Definitions, next: Definitions): void {
  for (const name of previous.keys()) {
    if (!next.has(name)) throw new Error(`Cannot automatically bridge removed definition ${name}`);
  }
}

class MigrationBridgeWriter {
  readonly output: string[] = [];
  private definition: DefinitionStorage | undefined;

  constructor(private readonly previous: Definitions) {}

  append(line: string): void {
    const start = /^definition\s+(\S+)\s*\{/.exec(line);
    if (start?.[1] !== undefined) this.openDefinition(start[1]);
    const permission = /^\s*permission\s+(\w+)\s*=/.exec(line)?.[1];
    if (permission !== undefined) this.definition?.permissions.add(permission);
    if (this.appendExpandedRelation(line)) return;
    const inlineDefinition = start !== null && line.trim().endsWith("}");
    if (line.trim() === "}" || inlineDefinition) {
      this.closeDefinition(line, inlineDefinition);
      return;
    }
    this.output.push(line);
  }

  private openDefinition(name: string): void {
    this.definition = {
      name,
      oldRelations: this.previous.get(name)?.relations ?? new Map(),
      seenRelations: new Set(),
      permissions: new Set(),
    };
  }

  private appendExpandedRelation(line: string): boolean {
    const relation = /^\s*relation\s+(\w+)\s*:\s*(.+)$/.exec(line);
    const name = relation?.[1];
    const allowedTypes = relation?.[2];
    if (name === undefined || allowedTypes === undefined) return false;
    this.definition?.seenRelations.add(name);
    const types = new Set([
      ...allowedTypes.split("|").map((type) => type.trim()),
      ...(this.definition?.oldRelations.get(name) ?? []),
    ]);
    this.output.push(`  relation ${name}: ${[...types].join(" | ")}`);
    return true;
  }

  private closeDefinition(line: string, inline: boolean): void {
    const definition = this.definition;
    const missing = [...(definition?.oldRelations ?? [])].filter(([role]) => !definition?.seenRelations.has(role));
    const expandInline = inline && missing.length > 0;
    // `missing` is empty without a definition, so expanding implies one.
    if (expandInline && definition !== undefined) this.output.push(`definition ${definition.name} {`);
    for (const [role, types] of missing) {
      if (definition?.permissions.has(role))
        throw new Error(`Cannot bridge relation/permission collision ${definition.name}#${role}`);
      this.output.push(`  relation ${role}: ${types.join(" | ")}`);
    }
    this.output.push(expandInline ? "}" : line);
    this.definition = undefined;
  }
}
