/**
 * Classifies a schema change the way SpiceDB's WriteSchema will judge it:
 * removing a definition, removing a relation, or removing an allowed subject
 * type is refused while stored relationships still use it — those need a
 * relationship step. Everything else (additions, permission changes) writes
 * cleanly, because permissions are computed and store no relationships.
 */

export type SchemaDiffClassification =
  { readonly kind: "additive" } | { readonly kind: "destructive"; readonly removals: readonly string[] };

type ParsedDefinition = {
  readonly relations: ReadonlyMap<string, readonly string[]>;
};

export function classifySchemaDiff(previousSchema: string, nextSchema: string): SchemaDiffClassification {
  const previous = parseZedDefinitions(previousSchema);
  const next = parseZedDefinitions(nextSchema);

  const removals: string[] = [];

  for (const [definitionName, previousDefinition] of previous) {
    const nextDefinition = next.get(definitionName);
    if (!nextDefinition) {
      removals.push(`definition ${definitionName}`);
      continue;
    }
    removals.push(...relationRemovals(definitionName, previousDefinition, nextDefinition));
  }

  return removals.length > 0 ? { kind: "destructive", removals } : { kind: "additive" };
}

function relationRemovals(
  definitionName: string,
  previous: ParsedDefinition,
  next: ParsedDefinition,
): readonly string[] {
  const removals: string[] = [];
  for (const [relationName, previousTypes] of previous.relations) {
    const nextTypes = next.relations.get(relationName);
    if (!nextTypes) {
      removals.push(`relation ${definitionName}#${relationName}`);
      continue;
    }
    for (const allowedType of previousTypes) {
      if (!nextTypes.includes(allowedType)) {
        removals.push(`allowed type ${allowedType} on ${definitionName}#${relationName}`);
      }
    }
  }
  return removals;
}

/**
 * Line-grammar parse of the composed .zed document — definitions, their
 * relations, and each relation's allowed subject types. Permissions are
 * deliberately not tracked: they store nothing, so changing them never
 * blocks a schema write.
 */
export function parseZedDefinitions(schema: string): ReadonlyMap<string, ParsedDefinition> {
  const parser = new ZedDefinitionParser();
  for (const rawLine of schema.split("\n")) {
    parser.consume(stripComment(rawLine).trim());
  }
  return parser.definitions;
}

class ZedDefinitionParser {
  readonly definitions = new Map<string, ParsedDefinition>();
  private currentName: string | undefined;
  private currentRelations: Map<string, readonly string[]> | undefined;

  consume(line: string): void {
    const definitionStart = /^definition\s+(\S+)\s*\{/.exec(line);
    if (definitionStart?.[1] !== undefined) {
      this.openDefinition(definitionStart[1], line.endsWith("}"));
      return;
    }
    if (this.currentName === undefined) {
      return;
    }
    if (line === "}") {
      this.closeDefinition();
      return;
    }
    this.consumeRelation(line);
  }

  private openDefinition(name: string, closesOnSameLine: boolean): void {
    this.currentName = name;
    this.currentRelations = new Map();
    // `definition name {}` opens and closes on one line.
    if (closesOnSameLine) {
      this.closeDefinition();
    }
  }

  private closeDefinition(): void {
    if (this.currentName !== undefined && this.currentRelations !== undefined) {
      this.definitions.set(this.currentName, {
        relations: this.currentRelations,
      });
    }
    this.currentName = undefined;
    this.currentRelations = undefined;
  }

  private consumeRelation(line: string): void {
    const relation = /^relation\s+(\w+)\s*:\s*(.+)$/.exec(line);
    if (relation?.[1] === undefined || relation[2] === undefined) {
      return;
    }
    this.currentRelations?.set(
      relation[1],
      relation[2]
        .split("|")
        // A patch's canonical text spaces its tokens (`set # member`,
        // `user : *`); a type is the same type however it is spaced.
        .map((allowedType) => allowedType.replace(/\s+/g, ""))
        .filter((allowedType) => allowedType.length > 0),
    );
  }
}

function stripComment(line: string): string {
  const commentStart = line.indexOf("//");
  return commentStart === -1 ? line : line.slice(0, commentStart);
}
