/** Scaffold a sequential `(from, to)` access migration file from two `.zed` schemas. */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseZed, type AccessIrDefinition } from "@dads-framework/access";
import {
  diffAccessIrDefinitions,
  type AccessDiffBreakingChange,
  type AccessSchemaDiff,
} from "./access-diff.js";
import {
  formatBreakingChange,
  formatSafeChange,
} from "./access-diff-format.js";
import { loadAccessSource } from "./access-source-loader.js";
import { readZedFile, writeTextArtifact } from "./access-zed-io.js";
import { isMissingPathError } from "./missing-path-error.js";

export const DEFAULT_ACCESS_MIGRATIONS_DIR = "access/migrations";

const SLUG_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const SEQUENTIAL_PREFIX_PATTERN = /^(\d{4})_/;

export type ScaffoldAccessMigrationOptions = {
  readonly slug: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly outDir?: string;
  readonly dryRun?: boolean;
  readonly cwd?: string;
};

export type AccessMigrationScaffoldResult = {
  readonly id: string;
  readonly slug: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly outDir: string;
  readonly filePath: string;
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly requiresMigration: boolean;
  readonly diff: AccessSchemaDiff;
  readonly code: string;
};

type MigrationStepRender = {
  readonly lines: readonly string[];
  readonly usesOps: boolean;
};

/**
 * Load two access sources (`.ts`, `.mts`, `.js`, `.mjs`, or `.zed`), compute
 * their schema diff, assign the next sequential `NNNN_<slug>` identifier in
 * `outDir`, and scaffold a `defineAccessMigration` module.
 */
export async function scaffoldAccessMigrationFromSources(
  options: ScaffoldAccessMigrationOptions,
): Promise<AccessMigrationScaffoldResult> {
  const slug = validateSlug(options.slug);
  const baseDirectory = options.cwd ?? process.cwd();
  const before = await loadAccessSource(options.fromPath, baseDirectory);
  const after = await loadAccessSource(options.toPath, baseDirectory);
  return buildMigrationScaffold({
    slug,
    fromPath: before.path,
    toPath: after.path,
    beforeDefs: before.definitions,
    afterDefs: after.definitions,
    outDir: resolve(
      baseDirectory,
      options.outDir ?? DEFAULT_ACCESS_MIGRATIONS_DIR,
    ),
    dryRun: options.dryRun === true,
  });
}

/**
 * Compute the schema diff between two `.zed` files, assign the next sequential
 * `NNNN_<slug>` identifier in `outDir`, and scaffold a `defineAccessMigration`
 * module pre-populated with typed `copyRole` / `dropRole` stubs and metadata.
 */
export function scaffoldAccessMigration(
  options: ScaffoldAccessMigrationOptions,
): AccessMigrationScaffoldResult {
  const slug = validateSlug(options.slug);
  const baseDirectory = options.cwd ?? process.cwd();
  const fromPath = resolve(baseDirectory, options.fromPath);
  const toPath = resolve(baseDirectory, options.toPath);
  return buildMigrationScaffold({
    slug,
    fromPath,
    toPath,
    beforeDefs: parseZed(readZedFile(fromPath)),
    afterDefs: parseZed(readZedFile(toPath)),
    outDir: resolve(
      baseDirectory,
      options.outDir ?? DEFAULT_ACCESS_MIGRATIONS_DIR,
    ),
    dryRun: options.dryRun === true,
  });
}

function buildMigrationScaffold(input: {
  readonly slug: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly beforeDefs: readonly AccessIrDefinition[];
  readonly afterDefs: readonly AccessIrDefinition[];
  readonly outDir: string;
  readonly dryRun: boolean;
}): AccessMigrationScaffoldResult {
  const diff = diffAccessIrDefinitions(input.beforeDefs, input.afterDefs);
  const id = nextMigrationId(input.outDir, input.slug);
  const filePath = join(input.outDir, `${id}.ts`);
  const code = renderMigrationModule({
    id,
    slug: input.slug,
    beforeDefs: input.beforeDefs,
    afterDefs: input.afterDefs,
    diff,
  });
  const written = writeTextArtifact(filePath, code, input.dryRun);

  return {
    id,
    slug: input.slug,
    fromPath: input.fromPath,
    toPath: input.toPath,
    outDir: input.outDir,
    filePath,
    dryRun: input.dryRun,
    written,
    requiresMigration: diff.requiresMigration,
    diff,
    code,
  };
}

function validateSlug(rawSlug: string): string {
  const slug = rawSlug.trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid migration slug "${rawSlug}". Use lowercase letters, digits, underscores, or hyphens (e.g. rename_editor).`,
    );
  }
  return slug;
}

function nextMigrationId(outDir: string, slug: string): string {
  const maxExisting = readHighestMigrationNumber(outDir);
  const nextNumber = String(maxExisting + 1).padStart(4, "0");
  return `${nextNumber}_${slug}`;
}

function readHighestMigrationNumber(outDir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return 0;
    }
    const detail =
      error instanceof Error ? error.message : "Unable to read directory.";
    throw new Error(
      `Unable to read migrations directory ${outDir}: ${detail}`,
      { cause: error },
    );
  }

  let highest = 0;
  for (const name of entries) {
    const match = SEQUENTIAL_PREFIX_PATTERN.exec(name);
    const digits = match?.[1];
    if (digits === undefined) continue;
    const parsed = Number.parseInt(digits, 10);
    if (parsed > highest) {
      highest = parsed;
    }
  }
  return highest;
}

function renderMigrationModule(input: {
  readonly id: string;
  readonly slug: string;
  readonly beforeDefs: readonly AccessIrDefinition[];
  readonly afterDefs: readonly AccessIrDefinition[];
  readonly diff: AccessSchemaDiff;
}): string {
  const stepRender = renderMigrationSteps(input.beforeDefs, input.diff);
  const snapshotLines = renderSnapshotMetadata(input);
  const stepsHeader = stepRender.usesOps
    ? "steps: (ops) => ["
    : "steps: () => [";
  const bodyLines =
    stepRender.lines.length === 0
      ? ["      // No breaking tuple changes detected."]
      : stepRender.lines;

  return [
    `/** Access migration ${input.id}. */`,
    "",
    'import type { AccessModel } from "@dads-framework/access";',
    "import {",
    "  defineAccessMigration,",
    "  type DefinedAccessMigration,",
    '} from "@dads-framework/spicedb-access/migration";',
    "",
    ...snapshotLines,
    "",
    "export function createAccessMigration(",
    "  from: AccessModel,",
    "  to: AccessModel,",
    "): DefinedAccessMigration {",
    `  return defineAccessMigration(${JSON.stringify(input.id)}, {`,
    "    from,",
    "    to,",
    `    ${stepsHeader}`,
    ...bodyLines,
    "    ],",
    "  });",
    "}",
    "",
  ].join("\n");
}

function renderSnapshotMetadata(input: {
  readonly id: string;
  readonly slug: string;
  readonly beforeDefs: readonly AccessIrDefinition[];
  readonly afterDefs: readonly AccessIrDefinition[];
  readonly diff: AccessSchemaDiff;
}): readonly string[] {
  const fromDefinitions = input.beforeDefs.map((def) => def.wireName);
  const toDefinitions = input.afterDefs.map((def) => def.wireName);
  const breaking = input.diff.breaking.map(formatBreakingChange);
  const safe = input.diff.safe.map(formatSafeChange);
  const requires = input.diff.requiresMigration ? "true" : "false";

  return [
    "export const migrationSnapshot = {",
    `  id: ${JSON.stringify(input.id)},`,
    `  slug: ${JSON.stringify(input.slug)},`,
    `  fromDefinitions: ${JSON.stringify(fromDefinitions)},`,
    `  toDefinitions: ${JSON.stringify(toDefinitions)},`,
    `  requiresMigration: ${requires},`,
    `  summary: ${JSON.stringify(input.diff.summary)},`,
    `  breakingChanges: ${JSON.stringify(breaking)},`,
    `  safeChanges: ${JSON.stringify(safe)},`,
    "};",
  ];
}

function renderMigrationSteps(
  beforeDefs: readonly AccessIrDefinition[],
  diff: AccessSchemaDiff,
): MigrationStepRender {
  const beforeByName = new Map(beforeDefs.map((def) => [def.wireName, def]));
  const addedRolesByResource = collectAddedRoles(diff);
  const lines: string[] = [];
  let usesOps = false;

  for (const change of diff.breaking) {
    const rendered = renderBreakingChangeStep(
      change,
      beforeByName,
      addedRolesByResource,
    );
    lines.push(...rendered.lines);
    if (rendered.usesOps) {
      usesOps = true;
    }
  }
  return { lines, usesOps };
}

function collectAddedRoles(
  diff: AccessSchemaDiff,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const change of diff.safe) {
    if (change.kind !== "added-role") continue;
    const existing = map.get(change.resource) ?? [];
    existing.push(change.role);
    map.set(change.resource, existing);
  }
  return map;
}

function renderBreakingChangeStep(
  change: AccessDiffBreakingChange,
  beforeByName: ReadonlyMap<string, AccessIrDefinition>,
  addedRolesByResource: ReadonlyMap<string, readonly string[]>,
): MigrationStepRender {
  switch (change.kind) {
    case "removed-role":
      return renderRemovedRoleStep(
        change.resource,
        change.role,
        addedRolesByResource.get(change.resource),
      );
    case "removed-resource":
      return renderRemovedResourceStep(
        change.resource,
        beforeByName.get(change.resource),
      );
    case "narrowed-role":
      return {
        usesOps: false,
        lines: [
          `      // Breaking: narrowed ${change.resource}#${change.role} (removed subject ${change.subject})`,
          `      // Review existing ${change.resource}#${change.role} relationships for subject ${change.subject} before writing the new schema.`,
        ],
      };
    case "removed-expiration":
      return {
        usesOps: false,
        lines: [
          `      // Breaking: removed expiration on ${change.resource}#${change.role} (${change.subject})`,
          `      // Clear or re-write expiring relationships on ${change.resource}#${change.role} before writing the new schema.`,
        ],
      };
  }
}

function renderRemovedRoleStep(
  resource: string,
  role: string,
  candidateTargets: readonly string[] | undefined,
): MigrationStepRender {
  const targetRole = candidateTargets?.[0] ?? "<new_role>";
  const fromRef = `{ resource: ${JSON.stringify(resource)}, role: ${JSON.stringify(role)} }`;
  const toRef = `{ resource: ${JSON.stringify(resource)}, role: ${JSON.stringify(targetRole)} }`;
  const lines = [
    `      // Breaking: removed role ${resource}#${role}`,
    `      // TODO: if migrating relationships to another role, uncomment copyRole before dropRole:`,
    `      // ops.copyRole(${fromRef}, ${toRef}),`,
    `      ops.dropRole(${fromRef}),`,
  ];
  return { lines, usesOps: true };
}

function renderRemovedResourceStep(
  resource: string,
  beforeDefinition: AccessIrDefinition | undefined,
): MigrationStepRender {
  const roles = beforeDefinition?.roles ?? [];
  if (roles.length === 0) {
    return {
      usesOps: false,
      lines: [
        `      // Breaking: removed resource ${resource} (no direct roles declared on resource).`,
      ],
    };
  }
  const lines: string[] = [`      // Breaking: removed resource ${resource}`];
  for (const role of roles) {
    const fromRef = `{ resource: ${JSON.stringify(resource)}, role: ${JSON.stringify(role.name)} }`;
    const toRef = `{ resource: "<new_resource>", role: ${JSON.stringify(role.name)} }`;
    lines.push(`      // ops.copyRole(${fromRef}, ${toRef}),`);
    lines.push(`      ops.dropRole(${fromRef}),`);
  }
  return { lines, usesOps: true };
}
