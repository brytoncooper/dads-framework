import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { migrateCommand } from "./cli-migrate-commands.js";
import { RETIRED_PACKAGE_TO_TARGET, rewriteV03ImportSpecifier } from "./migrate-v03-map.js";
import { migrateWorkspaceToV03 } from "./migrate-v03.js";

const tempDirs: string[] = [];

function createFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dads-migrate-v03-"));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("rewriteV03ImportSpecifier", () => {
  it("maps retired packages and subpaths to their 0.3.0 locations", () => {
    expect(rewriteV03ImportSpecifier("@dads-framework/contract")).toBe("@dads-framework/core/contract");
    expect(rewriteV03ImportSpecifier("@dads-framework/runtime/clock")).toBe("@dads-framework/core/runtime/clock");
    expect(rewriteV03ImportSpecifier("@dads-framework/authorization-migration")).toBe(
      "@dads-framework/spicedb-access/migration",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/authorization/testing")).toBe(
      "@dads-framework/spicedb-access/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/styles")).toBe("@dads-framework/ui/styles/index.css");
    expect(rewriteV03ImportSpecifier("@dads-framework/styles/fonts.css")).toBe("@dads-framework/ui/styles/fonts.css");
    expect(rewriteV03ImportSpecifier("@dads-framework/design-tokens/default.tokens.json")).toBe(
      "@dads-framework/ui/tokens/default.tokens.json",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/identity-better-auth")).toBe(
      "@dads-framework/identity/better-auth",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/http")).toBe("@dads-framework/http");
  });

  it("maps all 40 retired package names including the 12 consolidated 0.2.0 packages", () => {
    expect(Object.keys(RETIRED_PACKAGE_TO_TARGET)).toHaveLength(40);
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/clock"]).toBe("@dads-framework/core");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/diagnostics"]).toBe("@dads-framework/core");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/request-work"]).toBe("@dads-framework/core");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/health"]).toBe("@dads-framework/http");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/telemetry-core"]).toBe("@dads-framework/http");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/client-telemetry-core"]).toBe("@dads-framework/client");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/email-sender-core"]).toBe("@dads-framework/email");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/feature-flags-http"]).toBe("@dads-framework/feature-flags");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/feature-flags-postgres"]).toBe("@dads-framework/feature-flags");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/job-queue-core"]).toBe("@dads-framework/job-queue");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/object-storage-core"]).toBe("@dads-framework/object-storage");
    expect(RETIRED_PACKAGE_TO_TARGET["@dads-framework/testing-import-nx"]).toBe("@dads-framework/testing");
  });

  it("rewrites all 12 newly mapped 0.2.0 packages and subpaths without prefix collisions", () => {
    expect(rewriteV03ImportSpecifier("@dads-framework/clock")).toBe("@dads-framework/core/runtime/clock");
    expect(rewriteV03ImportSpecifier("@dads-framework/diagnostics")).toBe("@dads-framework/core/runtime/diagnostics");
    expect(rewriteV03ImportSpecifier("@dads-framework/diagnostics/testing")).toBe(
      "@dads-framework/core/runtime/diagnostics/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/request-work")).toBe("@dads-framework/core/runtime/request-work");
    expect(rewriteV03ImportSpecifier("@dads-framework/request-work/testing")).toBe(
      "@dads-framework/core/runtime/request-work/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/health")).toBe("@dads-framework/http/health");
    expect(rewriteV03ImportSpecifier("@dads-framework/telemetry-core")).toBe("@dads-framework/http/telemetry/core");
    expect(rewriteV03ImportSpecifier("@dads-framework/telemetry-core/testing")).toBe(
      "@dads-framework/http/telemetry/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/telemetry")).toBe("@dads-framework/http/telemetry");
    expect(rewriteV03ImportSpecifier("@dads-framework/client-telemetry-core")).toBe(
      "@dads-framework/client/telemetry/core",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/client-telemetry-core/testing")).toBe(
      "@dads-framework/client/telemetry/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/client-telemetry")).toBe("@dads-framework/client/telemetry");
    expect(rewriteV03ImportSpecifier("@dads-framework/email-sender-core")).toBe("@dads-framework/email/core");
    expect(rewriteV03ImportSpecifier("@dads-framework/email-sender-core/testing")).toBe(
      "@dads-framework/email/core/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/email-sender")).toBe("@dads-framework/email");
    expect(rewriteV03ImportSpecifier("@dads-framework/feature-flags-http")).toBe("@dads-framework/feature-flags/http");
    expect(rewriteV03ImportSpecifier("@dads-framework/feature-flags-postgres")).toBe(
      "@dads-framework/feature-flags/postgres",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/job-queue-core")).toBe("@dads-framework/job-queue/core");
    expect(rewriteV03ImportSpecifier("@dads-framework/job-queue-core/testing")).toBe(
      "@dads-framework/job-queue/core/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/job-queue-core/provider")).toBe(
      "@dads-framework/job-queue/core/provider",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/object-storage-core")).toBe(
      "@dads-framework/object-storage/core",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/object-storage-core/testing")).toBe(
      "@dads-framework/object-storage/testing",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/testing-import-nx")).toBe("@dads-framework/testing/nx");
  });
});

describe("migrateWorkspaceToV03", () => {
  it("rewrites manifests, adds newly-optional peers, rewrites imports, and is idempotent", () => {
    const root = createFixture({
      "package.json": JSON.stringify(
        {
          name: "sample-app",
          private: true,
          dependencies: {
            "@dads-framework/access": "^0.2.0",
            "@dads-framework/authorization": "^0.2.0",
            "@dads-framework/contract": "^0.2.0",
            "@dads-framework/email-sender": "^0.2.0",
            "@dads-framework/email-templates": "^0.2.0",
            "@dads-framework/errors": "^0.2.0",
            "@dads-framework/identity-better-auth": "^0.2.0",
            "@dads-framework/migrations": "^0.2.0",
            "@dads-framework/pdf": "^0.2.0",
            "@dads-framework/styles": "^0.2.0",
            "@dads-framework/tenants": "^0.2.0",
          },
          devDependencies: {
            "@dads-framework/testing-vitest": "^0.2.0",
          },
        },
        null,
        2,
      ),
      "dads.project.json": JSON.stringify(
        {
          schemaVersion: 1,
          packages: [
            {
              name: "sample-app",
              root: ".",
              kind: "composition",
              allowedDependencies: [
                "@dads-framework/contract",
                "@dads-framework/errors",
                "@dads-framework/authorization",
                "@dads-framework/tenants",
              ],
            },
          ],
        },
        null,
        2,
      ),
      "src/app.ts": [
        'import { entityIdSchema } from "@dads-framework/contract";',
        'import { AppError } from "@dads-framework/errors";',
        'import { FakeAuthorization } from "@dads-framework/authorization/testing";',
        'import { runNodePgMigrations } from "@dads-framework/migrations";',
        'import { defineCopy } from "@dads-framework/copy";',
        'import { toCsv } from "@dads-framework/csv";',
      ].join("\n"),
      "src/styles.css": '@import "@dads-framework/styles";\n',
    });

    const dry = migrateWorkspaceToV03({ root, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.filesChanged).toEqual(["dads.project.json", "package.json", "src/app.ts", "src/styles.css"]);
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toContain("@dads-framework/contract");

    const applied = migrateWorkspaceToV03({ root });
    expect(applied.dryRun).toBe(false);
    expect(applied.packageManifestsUpdated).toBe(1);
    expect(applied.importReplacements).toBe(7);
    expect(applied.addedPeers).toContain("better-auth");
    expect(applied.addedPeers).toContain("@react-email/components");
    expect(applied.addedPeers).toContain("pdfmake");

    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()),
        devDependencies: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    expect(manifest.dependencies["@dads-framework/core"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/spicedb-access"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/email"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/identity"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/postgres"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/documents"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/ui"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/contract"]).toBeUndefined();
    expect(manifest.devDependencies["@dads-framework/testing"]).toBe("^0.3.0");

    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe(
      [
        'import { entityIdSchema } from "@dads-framework/core/contract";',
        'import { AppError } from "@dads-framework/core/errors";',
        'import { FakeAuthorization } from "@dads-framework/spicedb-access/testing";',
        'import { runNodePgMigrations } from "@dads-framework/postgres/migrations";',
        'import { defineCopy } from "@dads-framework/ui/copy";',
        'import { toCsv } from "@dads-framework/documents/csv";',
      ].join("\n"),
    );
    expect(readFileSync(join(root, "src/styles.css"), "utf8")).toBe('@import "@dads-framework/ui/styles/index.css";\n');

    const project = z
      .object({
        packages: z.array(z.object({ allowedDependencies: z.array(z.string()) })),
      })
      .parse(JSON.parse(readFileSync(join(root, "dads.project.json"), "utf8")));
    expect(project.packages[0]?.allowedDependencies).toEqual([
      "@dads-framework/core",
      "@dads-framework/identity",
      "@dads-framework/spicedb-access",
    ]);

    const secondPass = migrateWorkspaceToV03({ root });
    expect(secondPass.filesChanged).toEqual([]);
    expect(secondPass.importReplacements).toBe(0);
    expect(secondPass.skippedMigrations).toEqual([]);
    expect(secondPass.followUps).toEqual([]);
  });

  it("migrates all 12 consolidated 0.2.0 packages across manifests and source imports idempotently", () => {
    const root = createFixture({
      "package.json": JSON.stringify(
        {
          name: "v02-app",
          private: true,
          dependencies: {
            "@dads-framework/client-telemetry": "^0.2.0",
            "@dads-framework/client-telemetry-core": "^0.2.0",
            "@dads-framework/clock": "^0.2.0",
            "@dads-framework/diagnostics": "^0.2.0",
            "@dads-framework/email-sender": "^0.2.0",
            "@dads-framework/email-sender-core": "^0.2.0",
            "@dads-framework/feature-flags-http": "^0.2.0",
            "@dads-framework/feature-flags-postgres": "^0.2.0",
            "@dads-framework/health": "^0.2.0",
            "@dads-framework/job-queue-core": "^0.2.0",
            "@dads-framework/object-storage-core": "^0.2.0",
            "@dads-framework/request-work": "^0.2.0",
            "@dads-framework/telemetry": "^0.2.0",
            "@dads-framework/telemetry-core": "^0.2.0",
          },
          devDependencies: {
            "@dads-framework/testing-import-nx": "^0.2.0",
          },
        },
        null,
        2,
      ),
      "src/index.ts": [
        'import { systemClock } from "@dads-framework/clock";',
        'import { createDiagnostics } from "@dads-framework/diagnostics";',
        'import { runRequestWork } from "@dads-framework/request-work";',
        'import { registerHealthRoutes } from "@dads-framework/health";',
        'import { requestTraceAttributes } from "@dads-framework/telemetry-core";',
        'import { startTelemetry } from "@dads-framework/telemetry";',
        'import { ClientTelemetry } from "@dads-framework/client-telemetry-core";',
        'import { createClientTelemetry } from "@dads-framework/client-telemetry";',
        'import { EmailSender } from "@dads-framework/email-sender-core";',
        'import { createResendEmailSender } from "@dads-framework/email-sender";',
        'import { registerFeatureFlagsHttp } from "@dads-framework/feature-flags-http";',
        'import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";',
        'import { JobQueue } from "@dads-framework/job-queue-core";',
        'import { ObjectStorage } from "@dads-framework/object-storage-core";',
        'import { importNxTestingWorkspace } from "@dads-framework/testing-import-nx";',
      ].join("\n"),
    });

    const applied = migrateWorkspaceToV03({ root });
    expect(applied.filesChanged).toEqual(["package.json", "src/index.ts"]);
    expect(applied.importReplacements).toBe(15);

    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()),
        devDependencies: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    expect(manifest.dependencies["@dads-framework/core"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/http"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/client"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/email"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/feature-flags"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/job-queue"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/object-storage"]).toBe("^0.3.0");
    expect(manifest.devDependencies["@dads-framework/testing"]).toBe("^0.3.0");
    expect(manifest.dependencies["@dads-framework/clock"]).toBeUndefined();
    expect(manifest.dependencies["@dads-framework/telemetry-core"]).toBeUndefined();

    expect(readFileSync(join(root, "src/index.ts"), "utf8")).toBe(
      [
        'import { systemClock } from "@dads-framework/core/runtime/clock";',
        'import { createDiagnostics } from "@dads-framework/core/runtime/diagnostics";',
        'import { runRequestWork } from "@dads-framework/core/runtime/request-work";',
        'import { registerHealthRoutes } from "@dads-framework/http/health";',
        'import { requestTraceAttributes } from "@dads-framework/http/telemetry/core";',
        'import { startTelemetry } from "@dads-framework/http/telemetry";',
        'import { ClientTelemetry } from "@dads-framework/client/telemetry/core";',
        'import { createClientTelemetry } from "@dads-framework/client/telemetry";',
        'import { EmailSender } from "@dads-framework/email/core";',
        'import { createResendEmailSender } from "@dads-framework/email";',
        'import { registerFeatureFlagsHttp } from "@dads-framework/feature-flags/http";',
        'import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags/postgres";',
        'import { JobQueue } from "@dads-framework/job-queue/core";',
        'import { ObjectStorage } from "@dads-framework/object-storage/core";',
        'import { importNxTestingWorkspace } from "@dads-framework/testing/nx";',
      ].join("\n"),
    );

    const secondPass = migrateWorkspaceToV03({ root });
    expect(secondPass.filesChanged).toEqual([]);
    expect(secondPass.importReplacements).toBe(0);
  });

  it("skips immutable migration files by default and rewrites them when includeMigrations is true", () => {
    const migrationSource = 'import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";\n';
    const cleanMigrationSource = 'export function up() { return "already-clean"; }\n';
    const root = createFixture({
      "package.json": JSON.stringify(
        {
          name: "migrations-app",
          dependencies: { "@dads-framework/feature-flags-postgres": "^0.2.0" },
        },
        null,
        2,
      ),
      "assembly/migrations.ts": 'import { runNodePgMigrations } from "@dads-framework/migrations";\n',
      "migrations/20261120080000_starter.migration.ts": migrationSource,
      "migrations/20261120080100_clean.migration.ts": cleanMigrationSource,
      "migrations/support/feature-flags.ts":
        'export { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";\n',
    });

    const first = migrateWorkspaceToV03({ root });
    expect(first.filesChanged).toEqual([
      "assembly/migrations.ts",
      "migrations/support/feature-flags.ts",
      "package.json",
    ]);
    expect(first.skippedMigrations).toEqual(["migrations/20261120080000_starter.migration.ts"]);
    expect(first.followUps).toHaveLength(1);
    expect(first.followUps[0]).toContain("--include-migrations");
    expect(readFileSync(join(root, "migrations/20261120080000_starter.migration.ts"), "utf8")).toBe(migrationSource);
    expect(readFileSync(join(root, "migrations/support/feature-flags.ts"), "utf8")).toBe(
      'export { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags/postgres";\n',
    );

    const secondDefault = migrateWorkspaceToV03({ root });
    expect(secondDefault.filesChanged).toEqual([]);
    expect(secondDefault.skippedMigrations).toEqual(["migrations/20261120080000_starter.migration.ts"]);

    const withMigrations = migrateWorkspaceToV03({ root, includeMigrations: true });
    expect(withMigrations.filesChanged).toEqual(["migrations/20261120080000_starter.migration.ts"]);
    expect(withMigrations.skippedMigrations).toEqual([]);
    expect(withMigrations.followUps).toEqual([]);
    expect(readFileSync(join(root, "migrations/20261120080000_starter.migration.ts"), "utf8")).toBe(
      'import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags/postgres";\n',
    );
  });

  it("reports relationshipExpirationMigration follow-up when postgres-access is used without an expiration migration", () => {
    const missingRoot = createFixture({
      "package.json": JSON.stringify(
        {
          name: "pg-access-app",
          dependencies: { "@dads-framework/postgres-access": "^0.2.0" },
        },
        null,
        2,
      ),
      "migrations/20261120080000_init.migration.ts":
        'import { relationshipSchemaMigration } from "@dads-framework/postgres-access";\n',
    });

    const missingResult = migrateWorkspaceToV03({ root: missingRoot });
    expect(missingResult.followUps.some((item) => item.includes("relationshipExpirationMigration.sql"))).toBe(true);
    expect(missingResult.followUps.some((item) => item.includes("expires_at"))).toBe(true);

    const secondMissing = migrateWorkspaceToV03({ root: missingRoot });
    expect(secondMissing.filesChanged).toEqual([]);
    expect(secondMissing.followUps.some((item) => item.includes("relationshipExpirationMigration.sql"))).toBe(true);

    const satisfiedBySymbolRoot = createFixture({
      "package.json": JSON.stringify(
        {
          name: "pg-access-satisfied-symbol",
          dependencies: { "@dads-framework/postgres-access": "^0.3.0" },
        },
        null,
        2,
      ),
      "migrations/20261123000000_relationship_expiration.migration.ts":
        'import { relationshipExpirationMigration } from "@dads-framework/postgres-access";\nexport const sql = relationshipExpirationMigration.sql;\n',
    });
    expect(migrateWorkspaceToV03({ root: satisfiedBySymbolRoot }).followUps).toEqual([]);

    const satisfiedByColumnRoot = createFixture({
      "package.json": JSON.stringify(
        {
          name: "pg-access-satisfied-column",
          dependencies: { "@dads-framework/postgres-access": "^0.3.0" },
        },
        null,
        2,
      ),
      "migrations/20261123000000_add_expires_at.migration.ts":
        'export const sql = "ALTER TABLE dad_authorization_relationship ADD COLUMN expires_at timestamptz NULL;";\n',
    });
    expect(migrateWorkspaceToV03({ root: satisfiedByColumnRoot }).followUps).toEqual([]);
  });

  it("prints skipped migrations, follow-ups, and honors --include-migrations in the CLI", () => {
    const root = createFixture({
      "package.json": JSON.stringify(
        {
          name: "cli-app",
          dependencies: {
            "@dads-framework/feature-flags-postgres": "^0.2.0",
            "@dads-framework/postgres-access": "^0.2.0",
          },
        },
        null,
        2,
      ),
      "migrations/20261120080000_starter.migration.ts":
        'import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";\n',
    });

    let stdout = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      migrateCommand(["0.3", root, "--dry-run"], false);
      expect(stdout).toContain("Skipped immutable migration file(s):");
      expect(stdout).toContain("migrations/20261120080000_starter.migration.ts");
      expect(stdout).toContain("Follow-up actions required:");
      expect(stdout).toContain("relationshipExpirationMigration.sql");

      stdout = "";
      migrateCommand(["0.3", root, "--include-migrations"], true);
      const payload = z
        .object({
          ok: z.literal(true),
          migration: z.object({
            skippedMigrations: z.array(z.string()),
            filesChanged: z.array(z.string()),
            followUps: z.array(z.string()),
          }),
        })
        .parse(JSON.parse(stdout));
      expect(payload.migration.skippedMigrations).toEqual([]);
      expect(payload.migration.filesChanged).toContain("migrations/20261120080000_starter.migration.ts");
      expect(payload.migration.followUps).toHaveLength(1);
      expect(payload.migration.followUps[0]).toContain("relationshipExpirationMigration.sql");
    } finally {
      spy.mockRestore();
    }
  });

  it("supports dad migrate 0.4 to jump directly from 0.2.x or 0.3.x to 0.4.0", () => {
    const root = createFixture({
      "package.json": JSON.stringify(
        {
          name: "wayline-jump",
          dependencies: {
            "@dads-framework/contract": "^0.2.0",
            "@dads-framework/health": "0.2.0",
            "@dads-framework/http": "0.3.0",
          },
        },
        null,
        2,
      ),
      "src/app.ts": `import { createHealthRoutes } from "@dads-framework/health";\nexport { createHealthRoutes };\n`,
    });

    let stdout = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      migrateCommand(["0.4", root], false);
      expect(stdout).toContain("Dad migrate 0.4: Updated 2 file(s)");
    } finally {
      spy.mockRestore();
    }

    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    expect(manifest.dependencies).toEqual({
      "@dads-framework/core": "^0.4.0",
      "@dads-framework/http": "0.4.0",
    });
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toContain("@dads-framework/http/health");
  });
});
