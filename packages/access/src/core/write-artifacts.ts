import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitZedForDefinitions } from "./emit-zed.js";
import { isGeneratedByAccessKit } from "./generated-header.js";
import type { AccessIrDefinition } from "./ir.js";

export type AccessArtifactTarget = {
  readonly relativePath: string;
  readonly wireNames: readonly string[];
};

function definitionMap(
  definitions: readonly AccessIrDefinition[],
): Map<string, AccessIrDefinition> {
  return new Map(
    definitions.map((definition) => [definition.wireName, definition]),
  );
}

function selectDefinitions(
  definitions: readonly AccessIrDefinition[],
  wireNames: readonly string[],
): AccessIrDefinition[] {
  const byName = definitionMap(definitions);
  return wireNames.map((wireName) => {
    const definition = byName.get(wireName);
    if (definition === undefined) {
      throw new Error(`no access() definition registered for ${wireName}`);
    }
    return definition;
  });
}

/**
 * A file this kit may replace is one this kit wrote — under today's header or
 * under any header it has retired (`generated-header.ts`). Recognizing only
 * today's would make the first run after a wording change refuse every file the
 * previous wording produced, which is the whole population.
 */
function assertWritable(path: string): void {
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!isGeneratedByAccessKit(existing)) {
    throw new Error(
      `refusing to overwrite ${path}: it carries no header this kit has ever written, so it is hand-written`,
    );
  }
}

/**
 * Write per-target generated `.zed` files. Idempotent. Refuses to clobber
 * a file this kit did not write.
 */
export function writeAccessArtifacts(options: {
  readonly repoRoot: string;
  readonly definitions: readonly AccessIrDefinition[];
  readonly targets: readonly AccessArtifactTarget[];
}): readonly string[] {
  const written: string[] = [];
  for (const target of options.targets) {
    const selected = selectDefinitions(options.definitions, target.wireNames);
    const path = join(options.repoRoot, target.relativePath);
    assertWritable(path);
    mkdirSync(dirname(path), { recursive: true });
    const body = emitZedForDefinitions(selected);
    writeFileSync(path, body);
    written.push(path);
  }
  return written;
}
