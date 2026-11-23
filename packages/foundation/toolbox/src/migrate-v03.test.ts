import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RETIRED_PACKAGE_TO_TARGET,
  rewriteV03ImportSpecifier,
} from "./migrate-v03-map.js";
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
    expect(rewriteV03ImportSpecifier("@dads-framework/contract")).toBe(
      "@dads-framework/core/contract",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/runtime/clock")).toBe(
      "@dads-framework/core/runtime/clock",
    );
    expect(
      rewriteV03ImportSpecifier("@dads-framework/authorization-migration"),
    ).toBe("@dads-framework/spicedb-access/migration");
    expect(
      rewriteV03ImportSpecifier("@dads-framework/authorization/testing"),
    ).toBe("@dads-framework/spicedb-access/testing");
    expect(rewriteV03ImportSpecifier("@dads-framework/styles")).toBe(
      "@dads-framework/ui/styles/index.css",
    );
    expect(rewriteV03ImportSpecifier("@dads-framework/styles/fonts.css")).toBe(
      "@dads-framework/ui/styles/fonts.css",
    );
    expect(
      rewriteV03ImportSpecifier(
        "@dads-framework/design-tokens/default.tokens.json",
      ),
    ).toBe("@dads-framework/ui/tokens/default.tokens.json");
    expect(
      rewriteV03ImportSpecifier("@dads-framework/identity-better-auth"),
    ).toBe("@dads-framework/identity/better-auth");
    expect(rewriteV03ImportSpecifier("@dads-framework/http")).toBe(
      "@dads-framework/http",
    );
  });

  it("maps all 28 retired package names", () => {
    expect(Object.keys(RETIRED_PACKAGE_TO_TARGET)).toHaveLength(28);
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
    expect(dry.filesChanged).toEqual([
      "dads.project.json",
      "package.json",
      "src/app.ts",
      "src/styles.css",
    ]);
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toContain(
      "@dads-framework/contract",
    );

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
    expect(manifest.dependencies["@dads-framework/spicedb-access"]).toBe(
      "^0.3.0",
    );
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
    expect(readFileSync(join(root, "src/styles.css"), "utf8")).toBe(
      '@import "@dads-framework/ui/styles/index.css";\n',
    );

    const project = z
      .object({
        packages: z.array(
          z.object({ allowedDependencies: z.array(z.string()) }),
        ),
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
  });
});
