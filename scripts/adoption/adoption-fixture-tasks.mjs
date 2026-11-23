/**
 * The adoption-fixture proof, expressed as independent tasks.
 *
 * Three kinds of task, all of them starting from the packed tarballs and none
 * of them depending on each other: install one package and import it, install a
 * fixture's closure and compile and run its program, and install the pair the
 * packed boundary verification needs. Nothing here decides how many run at
 * once — that is the runner's job.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isExecutableOnlyAdoptionPackage } from "./adoption-package-classification.mjs";
import { collectPackageClosure, tarballFor } from "./adoption-packing.mjs";
import { consolidatedPackageProof } from "./consolidated-package-proof.mjs";
import { createAdoptionFixtures } from "./verify-adoption-fixtures-cases.mjs";

/**
 * Roughly how many seconds each kind of task took when measured serially. The
 * numbers are only ever compared with each other: they decide which task the
 * pool starts first, and the packed boundary verification is one long serial
 * scenario that no amount of concurrency shortens, so it has to start first or
 * every other task finishes and waits for it.
 */
const TASK_SECONDS = {
  packageImport: 2,
  fixtureProgram: 5,
  packedBoundary: 40,
};

const FIXTURE_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2023", "DOM", "DOM.Iterable"],
    strict: true,
    outDir: "dist",
    // The published declarations are the product here, so an adopter checks
    // them rather than skipping past them.
    skipLibCheck: false,
  },
  include: ["*.ts"],
};

export function adoptionFixturesReceipt(
  packages,
  fixtures,
  concurrency,
  timings,
) {
  return {
    ok: true,
    publicPackages: packages.size,
    executableOnlyPackages: fixtures.executableOnlyPackages,
    adoptionFixtures: fixtures.fixtureNames,
    packedBoundaryVerification: true,
    concurrency,
    timings,
  };
}

export function createAdoptionFixtureTasks(context) {
  const fixtures = createAdoptionFixtures(context.root);
  const executableOnlyPackages = [...context.packages.keys()]
    .filter((packageName) =>
      isExecutableOnlyAdoptionPackage(
        context.packages.get(packageName)?.manifest,
      ),
    )
    .sort();
  return {
    executableOnlyPackages,
    fixtureNames: fixtures.map((fixture) => fixture.name),
    // Declared in reading order; the runner starts them in cost order.
    tasks: [
      ...packageImportTasks(context, executableOnlyPackages),
      ...fixtureProgramTasks(context, fixtures),
      packedBoundaryTask(context),
    ],
  };
}

function packageImportTasks(context, executableOnlyPackages) {
  return [...context.packages.keys()].map((packageName) => ({
    name: `import ${packageName}`,
    cost: TASK_SECONDS.packageImport,
    run: async (transcript) => {
      const executableOnly = executableOnlyPackages.includes(packageName);
      const fixture = createFixtureDirectory(
        context.workRoot,
        `package-${safeName(packageName)}`,
      );
      await context.time("package-install", () =>
        installPackageClosure(transcript, fixture, [packageName], context, {
          allowUnsupportedPlatform: executableOnly,
        }),
      );
      if (executableOnly) {
        transcript.note(
          `${packageName} is executable-only; there is nothing to import.`,
        );
        return;
      }
      await context.time("package-import", () =>
        transcript.run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            packageEntryProof(context.root, packageName),
          ],
          { cwd: fixture },
        ),
      );
    },
  }));
}

function packageEntryProof(root, packageName) {
  switch (packageName) {
    case "@dads-framework/ui":
      return `
        import tokens from "@dads-framework/ui/tokens/default.tokens.json" with { type: "json" };
        import { Button } from "@dads-framework/ui/elements";
        import { defineCopy } from "@dads-framework/ui/copy";
        ${readFileSync(
          join(root, "packages/web/ui/styles/verify-styles.test.mjs"),
          "utf8",
        )}
        assert.equal(tokens.palette.$type, "color");
        assert.ok(tokens.light);
        assert.ok(tokens.dark);
        assert.equal(typeof Button, "function");
        assert.equal(typeof defineCopy, "function");
      `;
    default:
      return (
        consolidatedPackageProof(packageName) ??
        `await import(${JSON.stringify(packageName)})`
      );
  }
}

function fixtureProgramTasks(context, fixtures) {
  return fixtures.map((definition) => ({
    name: `fixture ${definition.name}`,
    cost: TASK_SECONDS.fixtureProgram,
    run: async (transcript) => {
      const fixture = createFixtureDirectory(context.workRoot, definition.name);
      await context.time("fixture-install", () =>
        installPackageClosure(
          transcript,
          fixture,
          definition.packages,
          context,
          {
            vendorTypePackages: definition.vendorTypePackages,
          },
        ),
      );
      writeFixtureSources(fixture, definition);
      await context.time("fixture-compile", () =>
        transcript.run(
          process.execPath,
          [
            join(context.root, "node_modules/typescript/bin/tsc"),
            "-p",
            "tsconfig.json",
            "--pretty",
            "false",
          ],
          { cwd: fixture },
        ),
      );
      await context.time("fixture-run", () =>
        transcript.run(process.execPath, ["dist/index.js"], { cwd: fixture }),
      );
    },
  }));
}

function packedBoundaryTask(context) {
  return {
    name: "packed boundary verification",
    cost: TASK_SECONDS.packedBoundary,
    run: async (transcript) => {
      const fixture = createFixtureDirectory(
        context.workRoot,
        "packed-boundary-verification",
      );
      await context.time("boundary-install", () =>
        installPackageClosure(
          transcript,
          fixture,
          ["@dads-framework/access", "@dads-framework/toolbox"],
          context,
        ),
      );
      ensureBoundaryLockfile(fixture);
      await context.time("boundary-verify", () =>
        transcript.run(
          process.execPath,
          [
            join(
              context.root,
              "scripts/foundation/verify-boundary-verification.mjs",
            ),
          ],
          {
            cwd: context.root,
            env: boundaryEnvironment(context.root, fixture),
          },
        ),
      );
    },
  };
}

function boundaryEnvironment(root, fixture) {
  return {
    ...process.env,
    DADS_BOUNDARY_CLI_PATH: join(
      fixture,
      "node_modules/@dads-framework/toolbox/bin/dad.js",
    ),
    DADS_BOUNDARY_TYPESCRIPT_BIN: join(
      fixture,
      "node_modules/typescript/bin/tsc",
    ),
    DADS_BOUNDARY_VITEST_BIN: join(root, "node_modules/vitest/vitest.mjs"),
    DADS_BOUNDARY_ACCESS_ROOT: join(
      fixture,
      "node_modules/@dads-framework/access",
    ),
    DADS_BOUNDARY_LOCKFILE: join(fixture, "package-lock.json"),
  };
}

function writeFixtureSources(fixture, definition) {
  writeFileSync(join(fixture, "index.ts"), definition.source);
  for (const [name, source] of Object.entries(definition.files ?? {})) {
    writeFileSync(join(fixture, name), source);
  }
  if (definition.typeProof) {
    writeFileSync(join(fixture, "type-proof.ts"), definition.typeProof);
  }
  writeFileSync(
    join(fixture, "tsconfig.json"),
    JSON.stringify({
      ...FIXTURE_TSCONFIG,
      compilerOptions: {
        ...FIXTURE_TSCONFIG.compilerOptions,
        ...(definition.consumerConfig ?? {}),
      },
    }),
  );
}

function ensureBoundaryLockfile(fixture) {
  const lockfilePath = join(fixture, "package-lock.json");
  if (existsSync(lockfilePath)) return;
  const manifest = JSON.parse(
    readFileSync(join(fixture, "package.json"), "utf8"),
  );
  writeFileSync(
    lockfilePath,
    `${JSON.stringify({ lockfileVersion: 3, requires: true, packages: { "": manifest } }, null, 2)}\n`,
  );
}

function createFixtureDirectory(workRoot, name) {
  const fixture = join(workRoot, name);
  mkdirSync(fixture);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  return fixture;
}

/**
 * `options.vendorTypePackages` names declarations a vendored peer dependency
 * needs but does not ship, such as `@types/react` behind
 * `@tanstack/react-query`. A React adopter installs those next to the runtime,
 * so the fixture does too: its tsconfig checks every declaration it loads
 * rather than skipping library checks.
 */
function installPackageClosure(
  transcript,
  fixture,
  requested,
  context,
  options = {},
) {
  const ordered = [];
  for (const packageName of requested) {
    collectPackageClosure(packageName, context.packages, ordered);
  }
  return transcript.run(
    "npm",
    [
      "install",
      "--no-save",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...(options.allowUnsupportedPlatform ? ["--force"] : []),
      ...ordered.map((packageName) =>
        tarballFor(context.tarballs, packageName),
      ),
      ...(options.vendorTypePackages ?? []),
    ],
    { cwd: fixture },
  );
}

function safeName(packageName) {
  return packageName.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "");
}
