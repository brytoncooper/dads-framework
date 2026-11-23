import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMigrationWorkspace } from "../../index.js";
import { discoverDomainMigrations } from "./discover-domain-migrations.js";
import { listShippedDatabaseMigrations } from "./shipped-migration-files.js";

const organizationsMigrationFolder = "packages/server/organizations/src/lib/database/migrations";
const invoicesMigrationFolder = "packages/server/invoices/src/lib/database/migrations";
const authorizationMigrationFolder = "packages/server/authorization/src/lib/database/migrations";

/** The roots whose absence is a fault rather than a fact. */
const REQUIRED_ROOTS = ["packages/server"];

describe("discoverDomainMigrations", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty list when no owner migrations exist", async () => {
    workspaceRoot = await createWorkspace({});

    expect(
      await discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).toEqual([]);
  });

  it("refuses a tree where a library migration root is missing", async () => {
    // The fail-open this replaces: a moved folder made the walk return
    // nothing, the runner applied nothing, and the deploy reported success.
    workspaceRoot = await mkdtemp(join(tmpdir(), "domain-migrations-"));
    await mkdir(join(workspaceRoot, "apps"), {
      recursive: true,
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/packages\/server does not exist/);
  });

  it("accepts a tree with no app-owned migration folder, as the image has", async () => {
    // The runtime image COPYs the two library roots and the authorization
    // journal, and nothing else from the repository.
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    expect(discovered.map((row) => row.id)).toEqual(["20260101120000"]);
  });

  it("sorts distributed owners by timestamp id, not folder order", async () => {
    workspaceRoot = await createWorkspace({
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]: migrationModule(),
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      [join(authorizationMigrationFolder, "20260101120002_gamma.migration.ts")]: migrationModule({
        irreversible: true,
      }),
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });

    expect(discovered.map((row) => row.id)).toEqual(["20260101120000", "20260101120001", "20260101120002"]);
    expect(discovered.map((row) => row.owner)).toEqual(["organizations", "invoices", "authorization"]);
    expect(discovered[2]?.down).toBe(false);
  });

  it("ignores files outside the owner migration folders", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      "packages/server/organizations/src/lib/database/20260101120001_skip.migration.ts": migrationModule(),
      "apps/example/20260101120002_skip.migration.ts": migrationModule(),
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    expect(discovered.map((row) => row.id)).toEqual(["20260101120000"]);
  });

  it("refuses a migration that omits down", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: `export function up() {}
`,
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/down/);
  });

  it("refuses duplicate ids", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      [join(invoicesMigrationFolder, "20260101120000_beta.migration.ts")]: migrationModule(),
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/20260101120000/);
  });

  it("carries buildsIndexesConcurrently on a graph file", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = [];\nexport const buildsIndexesConcurrently = true;\n${migrationModule()}`,
    });

    const [discovered] = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });
    expect(discovered?.buildsIndexesConcurrently).toBe(true);
  });

  it("refuses buildsIndexesConcurrently on a legacy file", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const buildsIndexesConcurrently = true;\n${migrationModule()}`,
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/buildsIndexesConcurrently but no dependsOn/);
  });

  it("refuses buildsIndexesConcurrently together with ownTransaction", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = [];\nexport const ownTransaction = true;\nexport const buildsIndexesConcurrently = true;\n${migrationModule()}`,
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/both ownTransaction and buildsIndexesConcurrently/);
  });

  it("refuses an applied id that is missing from the build", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
        appliedIds: ["20260101120000", "20260101120099"],
      }),
    ).rejects.toThrow(/20260101120099/);
  });

  it("refuses a gap between applied ids and the discovered order", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]: migrationModule(),
      [join(authorizationMigrationFolder, "20260101120002_gamma.migration.ts")]: migrationModule(),
    });

    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
        appliedIds: ["20260101120000", "20260101120002"],
      }),
    ).rejects.toThrow(/20260101120001/);
  });

  it("accepts applied ids that are a prefix of the discovered order", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]: migrationModule(),
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
      appliedIds: ["20260101120000"],
    });

    expect(discovered.map((row) => row.id)).toEqual(["20260101120000", "20260101120001"]);
  });

  it("keeps a deployed independent graph migration before an earlier pending sibling", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = [];\n${migrationModule()}`,
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]:
        `export const dependsOn = [];\n${migrationModule()}`,
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
      appliedIds: ["20260101120001"],
    });

    expect(discovered.map((row) => row.id)).toEqual(["20260101120001", "20260101120000"]);
  });

  it("orders declared dependencies before a graph migration regardless of timestamps", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = ["20260101120001_beta.migration"];\n${migrationModule()}`,
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]:
        `export const dependsOn = [];\n${migrationModule()}`,
    });

    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
    });

    expect(discovered.map((row) => row.id)).toEqual(["20260101120001", "20260101120000"]);
  });

  it("allows graph migrations minted in the same second when full identities differ", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = [];\n${migrationModule()}`,
      [join(invoicesMigrationFolder, "20260101120000_beta.migration.ts")]:
        `export const dependsOn = [];\n${migrationModule()}`,
    });
    const discovered = await discoverDomainMigrations({
      workspace: defaultMigrationWorkspace(workspaceRoot),
      appliedIds: ["20260101120000_beta.migration"],
    });
    expect(discovered.map((row) => row.journalName)).toEqual([
      "20260101120000_beta.migration",
      "20260101120000_alpha.migration",
    ]);
    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
        appliedIds: ["20260101120000"],
      }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("rejects malformed dependency metadata at the module boundary", async () => {
    workspaceRoot = await createWorkspace({
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]:
        `export const dependsOn = [42];\n${migrationModule()}`,
    });
    await expect(
      discoverDomainMigrations({
        workspace: defaultMigrationWorkspace(workspaceRoot),
      }),
    ).rejects.toThrow(/must export/);
  });
});

// The status page lists what a build ships without executing any of it: the
// same owner, journal name, and checksum the runner would use, in run order.
describe("listShippedDatabaseMigrations", () => {
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("describes every shipped file in run order without loading its module", async () => {
    const unloadable = `throw new Error("a lister must never load a migration");\n`;
    workspaceRoot = await createWorkspace({
      [join(invoicesMigrationFolder, "20260101120001_beta.migration.ts")]: unloadable,
      [join(organizationsMigrationFolder, "20260101120000_alpha.migration.ts")]: migrationModule(),
      [join(authorizationMigrationFolder, "20260101120002_gamma.migration.ts")]: migrationModule({
        irreversible: true,
      }),
    });

    const shipped = await listShippedDatabaseMigrations(defaultMigrationWorkspace(workspaceRoot));

    expect(shipped).toEqual([
      {
        journalName: "20260101120000_alpha.migration",
        owner: "organizations",
        file: `${organizationsMigrationFolder}/20260101120000_alpha.migration.ts`,
        sha256: sha256Of(migrationModule()),
      },
      {
        journalName: "20260101120001_beta.migration",
        owner: "invoices",
        file: `${invoicesMigrationFolder}/20260101120001_beta.migration.ts`,
        sha256: sha256Of(unloadable),
      },
      {
        journalName: "20260101120002_gamma.migration",
        owner: "authorization",
        file: `${authorizationMigrationFolder}/20260101120002_gamma.migration.ts`,
        sha256: sha256Of(migrationModule({ irreversible: true })),
      },
    ]);
  });

  it("refuses a tree where a library migration root is missing, as the runner does", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "domain-migrations-"));
    await mkdir(join(workspaceRoot, "apps"), {
      recursive: true,
    });

    await expect(listShippedDatabaseMigrations(defaultMigrationWorkspace(workspaceRoot))).rejects.toThrow(
      /packages\/server does not exist/,
    );
  });
});

function sha256Of(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "domain-migrations-"));
  // The two library roots exist in every real checkout and in the runtime
  // image, so discovery refuses a tree without them; a fixture that omitted
  // one would be testing the refusal rather than the discovery.
  await Promise.all(REQUIRED_ROOTS.map((root) => mkdir(join(workspaceRoot, root), { recursive: true })));
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const filePath = join(workspaceRoot, relativePath);
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, contents);
    }),
  );
  return workspaceRoot;
}

function migrationModule(options?: { irreversible?: boolean }): string {
  const down = options?.irreversible === true ? "export const down = false;" : "export function down() {}";
  return `export function up() {}
${down}
`;
}
