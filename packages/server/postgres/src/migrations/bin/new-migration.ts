import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultMigrationWorkspace,
  discoverDomainMigrations,
} from "../index.js";

export type NewDomainMigrationInput = {
  owner: string;
  slug: string;
  workspaceRoot: string;
  now?: Date;
};

export type NewDomainMigrationResult = {
  filePath: string;
  id: string;
};

const SLUG = /^[a-z][a-z0-9_]*$/;

/**
 * The folder a new migration for `owner` goes in: `app` is the application's
 * top-level `migrations/` folder, and any other owner must be an existing
 * server part. An unknown owner is refused, never guessed from a table name.
 */
export function resolveMigrationOwnerFolder(
  workspaceRoot: string,
  owner: string,
): string {
  if (owner === "app") {
    return join(workspaceRoot, "migrations");
  }
  if (existsSync(join(workspaceRoot, "packages/server", owner))) {
    return join(
      workspaceRoot,
      "packages/server",
      owner,
      "src/lib/database/migrations",
    );
  }
  throw new Error(
    `unknown migration owner '${owner}' — pass a server part name or 'app'`,
  );
}

export function mintMigrationId(now: Date): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

export async function createDomainMigration(
  input: NewDomainMigrationInput,
): Promise<NewDomainMigrationResult> {
  if (!SLUG.test(input.slug)) {
    throw new Error(
      `slug '${input.slug}' must be lowercase letters, digits, and underscores`,
    );
  }
  const folder = resolveMigrationOwnerFolder(input.workspaceRoot, input.owner);
  const id = mintMigrationId(input.now ?? new Date());
  const fileName = `${id}_${input.slug}.migration.ts`;
  const filePath = join(folder, fileName);
  if (existsSync(filePath)) {
    throw new Error(`migration already exists: ${filePath}`);
  }
  const existing = await discoverDomainMigrations({
    workspace: defaultMigrationWorkspace(input.workspaceRoot),
  });
  if (
    existing.some(
      (migration) => migration.journalName === `${id}_${input.slug}.migration`,
    )
  ) {
    throw new Error(
      `migration already exists in another owner: ${id}_${input.slug}.migration`,
    );
  }
  const graph = existing.filter(
    (migration) => migration.dependsOn !== undefined,
  );
  const referenced = new Set(
    graph.flatMap((migration) => migration.dependsOn ?? []),
  );
  const frontier =
    graph.length === 0
      ? existing.slice(-1).map((migration) => migration.journalName)
      : graph
          .filter((migration) => !referenced.has(migration.journalName))
          .map((migration) => migration.journalName);
  await mkdir(folder, { recursive: true });
  await writeFile(filePath, migrationScaffold(frontier), { flag: "wx" });
  return { filePath, id };
}

function migrationScaffold(dependsOn: readonly string[]): string {
  return `import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn = ${JSON.stringify(dependsOn)};

export async function up(pgm: MigrationBuilder): Promise<void> {}

export async function down(pgm: MigrationBuilder): Promise<void> {}
`;
}

async function newMigrationFromArguments(): Promise<void> {
  const owner = process.argv[2];
  const slug = process.argv[3];
  if (owner === undefined || slug === undefined) {
    throw new Error("usage: dads-migration-new <owner> <slug>");
  }
  const result = await createDomainMigration({
    owner,
    slug,
    workspaceRoot: process.cwd(),
  });
  process.stdout.write(`created ${result.filePath}\n`);
}

if (/new-migration\.[jt]s$/.test(process.argv[1] ?? "")) {
  newMigrationFromArguments().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
