/**
 * The wrapper this repository's hooks call, end to end.
 *
 * `scripts/checks/check-source-budgets.mjs` is no longer an engine: it is the
 * path the pre-commit hook, the edit guard, the workflow, and `package.json`
 * already name, translating its flags to `dad doctor` and passing the exit code
 * and the output through. So it is tested the way it is used — copied into a
 * repository built for the test, spawned as a process, and read by its exit
 * code and its output.
 *
 * The repository the test builds points its own `bin/dad.js` at the built CLI
 * of this package, which is what makes the run end to end rather than a mock:
 * the wrapper spawns a real `dad doctor --gate` over a real tree.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACE_ROOT = join(PACKAGE_ROOT, "..", "..", "..");
const WRAPPER = join("scripts", "checks", "check-source-budgets.mjs");
const BUILT_CLI = join(PACKAGE_ROOT, "dist", "cli.js");
const TOOLBOX = join("packages", "foundation", "toolbox");
const OVER_CEILING = join("packages", "group", "name", "src", "long.ts");
const UNDER_CEILING = join("packages", "group", "name", "src", "short.ts");
const TIMEOUT = 120_000;

const BASELINE = `{
  "schemaVersion": 1,
  "countedLines": "non-blank, non-comment",
  "exempt": ["**/*.generated.ts", "**/dist/**"],
  "ceilings": {},
  "floors": {}
}
`;

function write(root: string, path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** A repository whose wrapper is this one and whose doctor is the built one. */
function buildRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "dad-gate-wrapper-"));
  mkdirSync(join(root, "scripts", "checks"), { recursive: true });
  copyFileSync(join(WORKSPACE_ROOT, WRAPPER), join(root, WRAPPER));
  write(root, join(".agents", "source-budgets.json"), BASELINE);
  write(root, "tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
  write(root, join(TOOLBOX, "bin", "dad.js"), 'import "../dist/cli.js";\n');
  write(
    root,
    join(TOOLBOX, "dist", "cli.js"),
    `import ${JSON.stringify(pathToFileURL(BUILT_CLI).href)};\n`,
  );
  write(
    root,
    OVER_CEILING,
    `${Array.from({ length: 401 }, (_, index) => `export const value${String(index)} = ${String(index)};`).join("\n")}\n`,
  );
  write(root, UNDER_CEILING, "export const value = 1;\n");
  return root;
}

function runWrapper(
  root: string,
  commandArguments: readonly string[],
): { status: number | null; stdout: string } {
  const finished = spawnSync(
    process.execPath,
    [join(root, WRAPPER), ...commandArguments],
    { cwd: root, encoding: "utf8" },
  );
  return { status: finished.status, stdout: finished.stdout };
}

describe("check-source-budgets, the wrapper", () => {
  it(
    "gates a repository through the built doctor and reports one file over its ceiling",
    { timeout: TIMEOUT },
    () => {
      const root = buildRepository();
      try {
        const over = runWrapper(root, ["--file", OVER_CEILING]);
        expect(over.stdout).toContain(
          "401 lines over the 400 ceiling and not listed",
        );
        expect(over.status).toBe(1);

        const under = runWrapper(root, ["--file", UNDER_CEILING]);
        expect(under.stdout).toMatch(/source budgets: 0 listed, 0 errors/);
        expect(under.status).toBe(0);

        // No mode flag at all means `--gate`, so a plain run judges the whole
        // repository rather than describing it.
        const plain = runWrapper(root, []);
        expect(plain.stdout).toMatch(/source budgets: \d+ listed/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "fails open in --file mode when the doctor is not built, and closed otherwise",
    { timeout: TIMEOUT },
    () => {
      const root = buildRepository();
      try {
        rmSync(join(root, TOOLBOX, "dist", "cli.js"));

        const guarded = runWrapper(root, ["--file", OVER_CEILING]);
        expect(guarded.status).toBe(0);
        expect(guarded.stdout).toContain("dad doctor is not built");
        expect(guarded.stdout).toContain("skipping this file");

        const gated = runWrapper(root, []);
        expect(gated.status).toBe(1);
        expect(gated.stdout).toContain("Run npm run build first.");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
