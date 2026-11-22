/** Load an access model and IR definitions from a `.zed` or `.ts`/`.js` module. */

import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  accessModel,
  compileAccess,
  emitAccessIr,
  parseZed,
  type AccessDefinition,
  type AccessIrDefinition,
  type AccessModel,
  type AnyDslResource,
  type DslActor,
  type DslNode,
  type EntityHandle,
  type ResolvedAccessDefinition,
} from "@dads-framework/access";
import { lowerIrToAccessModel } from "./access-ir-lowering.js";
import { readZedFile } from "./access-zed-io.js";
import { isRecord } from "./parse-guards.js";

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const PRIORITY_EXPORT_NAMES = ["default", "access", "model"] as const;

let loadNonce = 0;

export type AccessSourceKind = "zed" | "module";

export type LoadedAccessSource = {
  readonly path: string;
  readonly kind: AccessSourceKind;
  readonly model: AccessModel;
  readonly definitions: readonly AccessIrDefinition[];
};

type ClassicAccessDeclaration = Pick<
  AccessDefinition<unknown, unknown>,
  "entity" | "resolve"
>;

/**
 * Load an access schema from either a SpiceDB `.zed` file or a TypeScript /
 * JavaScript module (`.ts`, `.mts`, `.js`, `.mjs`) exporting an `AccessModel`,
 * DSL `actor(...)` / `resource(...)` definitions, or classic `access(...)`
 * declarations.
 */
export async function loadAccessSource(
  inputPath: string,
  cwd?: string,
): Promise<LoadedAccessSource> {
  const resolvedPath = resolve(cwd ?? process.cwd(), inputPath);
  const extension = extname(resolvedPath).toLowerCase();

  if (extension === ".zed") {
    return loadZedAccessSource(resolvedPath);
  }
  if (MODULE_EXTENSIONS.has(extension)) {
    return loadModuleAccessSource(resolvedPath);
  }
  throw new Error(
    `Unsupported access schema file "${resolvedPath}". Expected a .zed, .ts, .mts, .js, or .mjs file.`,
  );
}

function loadZedAccessSource(resolvedPath: string): LoadedAccessSource {
  const source = readZedFile(resolvedPath);
  const definitions = parseZed(source);
  const model = lowerIrToAccessModel(definitions);
  return {
    path: resolvedPath,
    kind: "zed",
    model,
    definitions,
  };
}

async function loadModuleAccessSource(
  resolvedPath: string,
): Promise<LoadedAccessSource> {
  if (!existsSync(resolvedPath)) {
    throw new Error(`Access schema file not found: ${resolvedPath}.`);
  }
  loadNonce += 1;
  const moduleUrl = `${pathToFileURL(resolvedPath).href}?t=${Date.now()}-${loadNonce}`;
  const loaded = await importModuleNamespace(moduleUrl, resolvedPath);
  const model = extractAccessModel(loaded, resolvedPath);
  const definitions = emitAccessIr(model);

  return {
    path: resolvedPath,
    kind: "module",
    model,
    definitions,
  };
}

async function importModuleNamespace(
  moduleUrl: string,
  resolvedPath: string,
): Promise<unknown> {
  try {
    const imported: unknown = await import(moduleUrl);
    return imported;
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? error.message : "Unable to import module.";
    throw new Error(`Unable to load access module ${resolvedPath}: ${detail}`, {
      cause: error,
    });
  }
}

function extractAccessModel(
  loaded: unknown,
  resolvedPath: string,
): AccessModel {
  const candidates = collectExportCandidates(loaded);
  const directModel = candidates.find(isAccessModel);
  if (directModel !== undefined) {
    return directModel;
  }

  const dslNodes = collectDslNodes(candidates);
  if (dslNodes.length > 0) {
    return compileAccess(dslNodes);
  }

  const classicDefinitions = collectClassicDefinitions(candidates);
  if (classicDefinitions.length > 0) {
    return accessModel(classicDefinitions);
  }

  throw new Error(
    `No access model or DSL definitions found in ${resolvedPath}. Export an AccessModel (from compileAccess(...) or accessModel(...)) or exported resource(...)/actor(...) definitions.`,
  );
}

function collectExportCandidates(loaded: unknown): readonly unknown[] {
  if (!isRecord(loaded)) {
    return [];
  }
  const seen = new Set<string>();
  const candidates: unknown[] = [];

  for (const key of PRIORITY_EXPORT_NAMES) {
    if (key in loaded) {
      seen.add(key);
      candidates.push(loaded[key]);
    }
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (!seen.has(key)) {
      candidates.push(value);
    }
  }
  return candidates;
}

function collectDslNodes(candidates: readonly unknown[]): readonly DslNode[] {
  const nodes: DslNode[] = [];
  const seen = new Set<DslNode>();

  const addNode = (node: DslNode): void => {
    if (!seen.has(node)) {
      seen.add(node);
      nodes.push(node);
    }
  };

  for (const candidate of candidates) {
    if (isDslNode(candidate)) {
      addNode(candidate);
    } else if (Array.isArray(candidate) && candidate.every(isDslNode)) {
      for (const entry of candidate) {
        addNode(entry);
      }
    }
  }
  return nodes;
}

function collectClassicDefinitions(
  candidates: readonly unknown[],
): readonly ClassicAccessDeclaration[] {
  const declarations: ClassicAccessDeclaration[] = [];
  const seen = new Set<ClassicAccessDeclaration>();

  const addDeclaration = (declaration: ClassicAccessDeclaration): void => {
    if (!seen.has(declaration)) {
      seen.add(declaration);
      declarations.push(declaration);
    }
  };

  for (const candidate of candidates) {
    if (isClassicAccessDeclaration(candidate)) {
      addDeclaration(candidate);
    } else if (
      Array.isArray(candidate) &&
      candidate.every(isClassicAccessDeclaration)
    ) {
      for (const entry of candidate) {
        addDeclaration(entry);
      }
    }
  }
  return declarations;
}

function hasProperty<K extends string>(
  value: object,
  key: K,
): value is Record<K, unknown> {
  return key in value;
}

function readObjectProperty(value: object, key: string): unknown {
  return hasProperty(value, key) ? value[key] : undefined;
}

function isEntityHandle(value: unknown): value is EntityHandle {
  return (
    isRecord(value) &&
    typeof value["wireName"] === "string" &&
    isRecord(value["idSchema"])
  );
}

function isResolvedAccessDefinition(
  value: unknown,
): value is ResolvedAccessDefinition {
  if (!isRecord(value)) return false;
  return (
    isEntityHandle(value["entity"]) &&
    isRecord(value["roles"]) &&
    isRecord(value["permissions"]) &&
    isRecord(value["expressions"]) &&
    Array.isArray(value["catalogOnly"])
  );
}

function isAccessModel(value: unknown): value is AccessModel {
  if (!isRecord(value)) return false;
  const definitions = value["definitions"];
  const bindings = value["bindings"];
  const exceptions = value["visibleRecordExceptions"];
  if (
    !Array.isArray(definitions) ||
    !Array.isArray(bindings) ||
    !Array.isArray(exceptions)
  ) {
    return false;
  }
  return definitions.every(isResolvedAccessDefinition);
}

function isDslActorNode(value: unknown): value is DslActor {
  if (typeof value !== "function") return false;
  return (
    readObjectProperty(value, "kind") === "dsl-actor" &&
    typeof readObjectProperty(value, "wireName") === "string" &&
    isEntityHandle(readObjectProperty(value, "handle"))
  );
}

function isDslResourceNode(value: unknown): value is AnyDslResource {
  if (typeof value !== "function") return false;
  return (
    readObjectProperty(value, "kind") === "dsl-resource" &&
    typeof readObjectProperty(value, "wireName") === "string" &&
    isEntityHandle(readObjectProperty(value, "handle")) &&
    isRecord(readObjectProperty(value, "roles")) &&
    isRecord(readObjectProperty(value, "permissions"))
  );
}

function isDslNode(value: unknown): value is DslNode {
  return isDslActorNode(value) || isDslResourceNode(value);
}

function isClassicAccessDeclaration(
  value: unknown,
): value is ClassicAccessDeclaration {
  return (
    isRecord(value) &&
    isEntityHandle(value["entity"]) &&
    typeof value["resolve"] === "function"
  );
}
