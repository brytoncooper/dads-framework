import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../parse-guards.js";
import {
  buildPrunedManifests,
  bundleNodeApp,
  collectRuntimeDependencies,
  packageNameFromSpecifier,
  type EsbuildLike,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("@dads-framework/testing/esbuild", () => {
  it("extracts bare and scoped package names from specifiers and node_modules paths", () => {
    expect(packageNameFromSpecifier("pino/file")).toBe("pino");
    expect(packageNameFromSpecifier("@napi-rs/canvas/index.js")).toBe("@napi-rs/canvas");
    expect(packageNameFromSpecifier("apps/api/node_modules/@scope/pkg/dist/a.js")).toBe("@scope/pkg");
    expect(packageNameFromSpecifier("./local")).toBeUndefined();
    expect(packageNameFromSpecifier("node:fs")).toBeUndefined();
  });

  it("collects runtime deps from externals, metafile, and extraRuntimeDeps and prunes lockfile cleanly", () => {
    const rootPackageJson = {
      packageManager: "npm@10.9.0",
      dependencies: { pino: "^9.0.0", pg: "^8.13.0", "node-pg-migrate": "^7.0.0", unused: "^1.0.0" },
    };
    const metafile = {
      inputs: {
        "apps/api/src/main.ts": { imports: [{ original: "pg" }, { original: "./local" }] },
        "node_modules/pino/pino.js": { imports: [] },
      },
    };
    const deps = collectRuntimeDependencies({
      external: ["sharp"],
      extraRuntimeDeps: ["node-pg-migrate"],
      metafile,
      rootPackageJson,
    });
    expect(deps).toEqual(["node-pg-migrate", "pg", "pino", "sharp"]);

    const rootLockfile = {
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/pino": { version: "9.5.0", dev: true, dependencies: { "sonic-boom": "^4.0.0" } },
        "node_modules/sonic-boom": { version: "4.1.0", devOptional: true },
        "node_modules/pg": { version: "8.13.1" },
        "node_modules/node-pg-migrate": { version: "7.8.0" },
        "node_modules/sharp": { version: "0.33.5" },
        "node_modules/unused": { version: "1.0.0" },
      },
    };
    const { prunedPackageJson, prunedPackageLock } = buildPrunedManifests({
      packageName: "api-server",
      runtimeDeps: deps,
      rootPackageJson,
      rootLockfile,
    });
    expect(prunedPackageJson).toEqual({
      name: "api-server",
      version: "0.0.1",
      dependencies: { "node-pg-migrate": "7.8.0", pg: "8.13.1", pino: "9.5.0", sharp: "0.33.5" },
      packageManager: "npm@10.9.0",
      main: "./main.cjs",
      type: "commonjs",
    });
    const rawPackages = prunedPackageLock["packages"];
    expect(isRecord(rawPackages)).toBe(true);
    if (isRecord(rawPackages)) {
      expect(Object.keys(rawPackages)).toEqual([
        "",
        "node_modules/node-pg-migrate",
        "node_modules/pg",
        "node_modules/pino",
        "node_modules/sharp",
        "node_modules/sonic-boom",
      ]);
      const pinoEntry = rawPackages["node_modules/pino"];
      const sonicEntry = rawPackages["node_modules/sonic-boom"];
      expect(isRecord(pinoEntry) ? pinoEntry["dev"] : "bad").toBeUndefined();
      expect(isRecord(sonicEntry) ? sonicEntry["devOptional"] : "bad").toBeUndefined();
    }
  });

  it("runs bundleNodeApp, emits pruned manifests, and enforces post-build safety checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dads-esbuild-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { pg: "^8.13.0" } }));
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/pg": { version: "8.13.1" } } }),
    );

    const fakeEsbuild: EsbuildLike = {
      build: (options) => {
        const outfile = String(options["outfile"]);
        writeFileSync(outfile, 'const pg = require("pg");\n', "utf8");
        return Promise.resolve({ metafile: { inputs: { "apps/api/src/main.ts": { imports: [{ original: "pg" }] } } } });
      },
    };

    const result = await bundleNodeApp({
      esbuild: fakeEsbuild,
      workspaceRoot: dir,
      target: {
        name: "api-server",
        entry: "apps/api/src/main.ts",
        outputPath: "dist/api",
        outputFileName: "main.cjs",
        tsconfig: "tsconfig.json",
        external: ["pg"],
        generatePackageJson: true,
        writeMetafile: true,
        checks: [{ kind: "forbid-substring", substring: "testcontainers", label: "no-testcontainers" }],
      },
    });
    expect(result.runtimeDeps).toEqual(["pg"]);
    expect(JSON.parse(readFileSync(join(dir, "dist/api/package.json"), "utf8"))).toMatchObject({
      name: "api-server",
      dependencies: { pg: "8.13.1" },
    });
    expect(readFileSync(join(dir, "dist/api/meta.json"), "utf8")).toContain("apps/api/src/main.ts");

    await expect(
      bundleNodeApp({
        esbuild: fakeEsbuild,
        workspaceRoot: dir,
        target: {
          name: "api-server",
          entry: "apps/api/src/main.ts",
          outputPath: "dist/api-fail",
          outputFileName: "main.cjs",
          tsconfig: "tsconfig.json",
          checks: [{ kind: "forbid-pattern", pattern: /require\("pg"\)/, label: "forbid-pg" }],
        },
      }),
    ).rejects.toThrow('api-server bundle failed check "forbid-pg".');
  });
});
