export type ZedRelation = {
  resourceType: string;
  relation: string;
};

export type ZedSchemaSurface = {
  resourceTypes: ReadonlySet<string>;
  relations: readonly ZedRelation[];
};

/** Parses definition and relation names from a Zed schema; ignores permissions. */
export function parseZedSchemaSurface(schema: string): ZedSchemaSurface {
  const text = stripZedComments(schema);
  const resourceTypes = new Set<string>();
  const relations: ZedRelation[] = [];
  const definitionPattern = /\bdefinition\s+([A-Za-z][A-Za-z0-9_/]*)\s*\{/g;

  let match = definitionPattern.exec(text);
  while (match !== null) {
    const resourceType = match[1];
    const openBraceIndex = match.index + match[0].length - 1;
    if (resourceType === undefined) {
      match = definitionPattern.exec(text);
      continue;
    }
    const closeBraceIndex = matchingBraceIndex(text, openBraceIndex);
    resourceTypes.add(resourceType);
    relations.push(...relationsInDefinition(resourceType, text.slice(openBraceIndex + 1, closeBraceIndex)));
    match = definitionPattern.exec(text);
  }

  return { resourceTypes, relations };
}

function relationsInDefinition(resourceType: string, body: string): readonly ZedRelation[] {
  const relations: ZedRelation[] = [];
  const relationPattern = /\brelation\s+([A-Za-z][A-Za-z0-9_]*)\s*:/g;
  let relationMatch = relationPattern.exec(body);
  while (relationMatch !== null) {
    const relation = relationMatch[1];
    if (relation !== undefined) {
      relations.push({ resourceType, relation });
    }
    relationMatch = relationPattern.exec(body);
  }
  return relations;
}

function stripZedComments(schema: string): string {
  return schema.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function matchingBraceIndex(text: string, openBraceIndex: number): number {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return text.length;
}
