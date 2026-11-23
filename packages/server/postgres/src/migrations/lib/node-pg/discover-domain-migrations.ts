import { join } from "node:path";
import { z } from "zod";
import type {
  DiscoverDomainMigrationsInput,
  DiscoveredDomainMigration,
  DomainMigrationFunction,
} from "./domain-migration.js";
import { loadDomainMigrationModule } from "./load-domain-migration-module.js";
import { planMigrationOrder } from "./plan-migration-order.js";
import {
  idFromFileName,
  journalNameFromRelativePath,
  listMigrationRelativePaths,
  ownerFromRelativePath,
} from "./shipped-migration-files.js";

const migrationFunctionSchema = z.custom<DomainMigrationFunction>((value) => typeof value === "function");

const domainMigrationModuleSchema = z.object({
  up: migrationFunctionSchema,
  down: z.union([migrationFunctionSchema, z.literal(false)]),
  dependsOn: z.array(z.string().regex(/^\d{14}_[a-z0-9_]+\.migration$/)).optional(),
  ownTransaction: z.literal(true).optional(),
  buildsIndexesConcurrently: z.literal(true).optional(),
});

export async function discoverDomainMigrations(
  input: DiscoverDomainMigrationsInput,
): Promise<DiscoveredDomainMigration[]> {
  const relativePaths = (await listMigrationRelativePaths(input.workspace)).toSorted((left, right) =>
    idFromFileName(left).localeCompare(idFromFileName(right)),
  );

  const discovered: DiscoveredDomainMigration[] = [];
  const seenIds = new Map<string, string>();

  for (const relativePath of relativePaths) {
    discovered.push(await readDiscoveredMigration(input.workspace, relativePath, seenIds));
  }

  const appliedNames = input.appliedIds?.map((id) => resolveAppliedMigration(id, discovered));
  return planMigrationOrder(discovered, appliedNames);
}

async function readDiscoveredMigration(
  workspace: DiscoverDomainMigrationsInput["workspace"],
  relativePath: string,
  seenIds: Map<string, string>,
): Promise<DiscoveredDomainMigration> {
  const filePath = join(workspace.root, relativePath);
  const fileId = idFromFileName(relativePath);
  const pathOwner = ownerFromRelativePath(workspace, relativePath);
  assertValidTimestampId(fileId, relativePath);

  const loaded = domainMigrationModuleSchema.safeParse(await loadDomainMigrationModule(filePath, workspace));
  if (!loaded.success) {
    throw new Error(`migration ${relativePath} must export up and an explicit down function or down: false`);
  }

  const { ownTransaction = false, buildsIndexesConcurrently = false } = loaded.data;
  if (loaded.data.dependsOn === undefined) {
    assertLegacyFile(
      fileId,
      relativePath,
      {
        ownTransaction,
        buildsIndexesConcurrently,
      },
      seenIds,
    );
  }
  if (ownTransaction && buildsIndexesConcurrently) {
    throw new Error(
      `migration ${relativePath} exports both ownTransaction and buildsIndexesConcurrently; a concurrent index file already runs alone, outside a transaction`,
    );
  }
  return {
    id: fileId,
    owner: pathOwner,
    up: loaded.data.up,
    down: loaded.data.down,
    filePath,
    journalName: journalNameFromRelativePath(relativePath),
    ...(loaded.data.dependsOn === undefined ? {} : { dependsOn: loaded.data.dependsOn }),
    ...(ownTransaction ? { ownTransaction: true } : {}),
    ...(buildsIndexesConcurrently ? { buildsIndexesConcurrently: true } : {}),
  };
}

function resolveAppliedMigration(id: string, discovered: readonly DiscoveredDomainMigration[]): string {
  const matches = discovered.filter((entry) => entry.id === id || entry.journalName === id);
  if (matches.length > 1) {
    throw new Error(`applied migration ${id} is ambiguous; use its full journal name`);
  }
  const migration = matches[0];
  if (migration === undefined) {
    throw new Error(`applied migration ${id} is missing from the current build`);
  }
  return migration.journalName;
}

function assertLegacyFile(
  fileId: string,
  relativePath: string,
  runMode: {
    ownTransaction: boolean;
    buildsIndexesConcurrently: boolean;
  },
  seenIds: Map<string, string>,
): void {
  if (runMode.ownTransaction) {
    throw new Error(
      `migration ${relativePath} exports ownTransaction but no dependsOn; only graph files can commit alone`,
    );
  }
  if (runMode.buildsIndexesConcurrently) {
    throw new Error(
      `migration ${relativePath} exports buildsIndexesConcurrently but no dependsOn; only graph files can build indexes concurrently`,
    );
  }
  const existingPath = seenIds.get(fileId);
  if (existingPath !== undefined) {
    throw new Error(`migration id ${fileId} is declared by both ${existingPath} and ${relativePath}`);
  }
  seenIds.set(fileId, relativePath);
}

function assertValidTimestampId(id: string, relativePath: string): void {
  const year = Number(id.slice(0, 4));
  const month = Number(id.slice(4, 6));
  const day = Number(id.slice(6, 8));
  const hour = Number(id.slice(8, 10));
  const minute = Number(id.slice(10, 12));
  const second = Number(id.slice(12, 14));
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const matches =
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() + 1 === month &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second;
  if (!matches) {
    throw new Error(`migration ${relativePath} id ${id} is not a valid UTC timestamp`);
  }
}
