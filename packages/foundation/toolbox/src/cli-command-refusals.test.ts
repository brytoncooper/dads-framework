/** Proves every `dad` command refuses an argument list it cannot act on, through the published executable. */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DADDY_ISSUES } from "./doctor/issues.js";

const dadExecutable = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "dad.js",
);
const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("dad inspection command refusals", () => {
  it("refuses duplicate or missing verification option values", () => {
    const projectRoot = createProject();
    expectRefusal(
      runDad(projectRoot, [
        "test:recommend",
        "--changed",
        "--base",
        "main",
        "--base",
        "release",
      ]),
      "--base may only be provided once.",
    );
    expectRefusal(
      runDad(projectRoot, ["test:recommend", "--changed", "--base"]),
      "--base requires a value.",
    );
    expectRefusal(
      runDad(projectRoot, ["test:recommend", "--base", "--changed"]),
      "--base requires a value.",
    );
  });

  it("refuses orient without a path and orient for a path no package owns", () => {
    const projectRoot = createProject();

    expectRefusal(
      runDad(projectRoot, ["orient"]),
      "orient requires a project-relative path.",
    );
    expectRefusal(
      runDad(projectRoot, ["orient", "docs/README.md"]),
      "No declared package owns docs/README.md.",
    );
  });

  it("prints existing documentation for orientation and doctor explanations", () => {
    const projectRoot = createProject();
    const ownerReadme = join(projectRoot, "src", "README.md");
    const issues = join(projectRoot, "docs", "daddy-issues.md");
    writeFileSync(ownerReadme, "# Application guidance\n");
    mkdirSync(join(projectRoot, "docs"));
    writeFileSync(issues, "## Enmeshment\n");

    const orientation = runDad(projectRoot, [
      "orient",
      "src/existing.ts",
      "--json",
    ]);
    expect(orientation.status).toBe(0);
    expect(orientation.stdout).toContain(
      `"documentation":${JSON.stringify(ownerReadme)}`,
    );

    const explanation = runDad(projectRoot, [
      "doctor",
      "explain",
      "enmeshment",
      "--json",
    ]);
    expect(explanation.status).toBe(0);
    expect(explanation.stdout).toContain(
      `"documentation":${JSON.stringify(`${issues}#enmeshment`)}`,
    );

    const refusal = runDad(projectRoot, ["doctor", "explain", "unknown"]);
    expectRefusal(refusal, "No daddy issue is named unknown.");
    expect(refusal.stderr).toContain(issues);
  });

  it("keeps Doctor explain anchors in the owned reference", () => {
    const text = readFileSync(
      new URL("../../../../docs/daddy-issues.md", import.meta.url),
      "utf8",
    );
    for (const { id } of DADDY_ISSUES) expect(text).toContain(`(#${id})`);
  });

  it("refuses inspect without an operation and for an operation no source declares", () => {
    const projectRoot = createProject();

    expectRefusal(
      runDad(projectRoot, ["inspect"]),
      'inspect requires http-operation "<METHOD /path>".',
    );
    expectRefusal(
      runDad(projectRoot, ["inspect", "http-route", "getThing"]),
      'inspect requires http-operation "<METHOD /path>".',
    );
    expectRefusal(
      runDad(projectRoot, ["inspect", "http-operation", "getThing"]),
      "No literal HTTP operation named getThing was found.",
    );
  });
});

describe("dad project command refusals", () => {
  it("refuses init arguments the parser cannot resolve", () => {
    const projectRoot = createProject();

    expectRefusal(
      runDad(projectRoot, ["init"]),
      "Provide a Dads project directory.",
    );
    expectRefusal(
      runDad(projectRoot, [
        "init",
        "api",
        "--name",
        "first-app",
        "--name",
        "second-app",
      ]),
      "Option --name was provided more than once.",
    );
    expectRefusal(
      runDad(projectRoot, ["init", "api", "--name"]),
      "--name requires a value.",
    );
  });
});

type DadRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function expectRefusal(completed: DadRun, message: string): void {
  expect(completed.stderr).toContain(`Dad: ${message}`);
  expect(completed.status).toBe(1);
  expect(completed.stdout).toBe("");
}

function runDad(
  projectRoot: string,
  commandArguments: readonly string[],
): DadRun {
  const completed = spawnSync(
    process.execPath,
    [dadExecutable, ...commandArguments],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (completed.error) throw completed.error;
  return {
    status: completed.status,
    stdout: completed.stdout,
    stderr: completed.stderr,
  };
}

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-cli-refusals-"));
  temporaryProjects.push(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(
    join(projectRoot, "src/existing.ts"),
    "export const existing = 1;\n",
  );
  writeFileSync(
    join(projectRoot, "dads.project.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      capabilities: [],
      packages: [
        {
          name: "app",
          root: "src",
          responsibility: "Owns application code.",
          allowedDependencies: [],
          verification: ["npm test"],
          skills: ["add-http-operation"],
        },
      ],
    })}\n`,
  );
  return projectRoot;
}
