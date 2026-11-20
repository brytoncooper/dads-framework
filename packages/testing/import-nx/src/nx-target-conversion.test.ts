import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NxProject, NxTarget } from "./import-nx-types.js";
import { convertTarget } from "./nx-target-conversion.js";

/**
 * A converted task must run without Nx, without a shell, and with nothing left
 * to resolve at execution time. Each case below is a recipe that fails one of
 * those three, and the proof is that it produces no task and an audit saying
 * why rather than a task that only works inside Nx.
 */

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("convertTarget refusals", () => {
  it("converts a fully materialized recipe and records its placeholder substitutions", async () => {
    const conversion = await convert({
      command: "node {projectRoot}/tools/test.mjs",
      cwd: "{projectRoot}",
    });

    expect(conversion.task?.execution).toEqual({
      executable: "node",
      args: ["apps/app/tools/test.mjs"],
      cwd: "apps/app",
    });
    expect(conversion.audit.classification).toBe("converted");
    expect(conversion.audit.substitutions).toEqual([
      { placeholder: "{projectRoot}", value: "apps/app" },
      { placeholder: "{projectRoot}", value: "apps/app" },
    ]);
  });

  it("refuses a command that still contains an unresolved Nx placeholder", async () => {
    await expectOpaque(
      { command: "node tools/test.mjs --out {options.outputPath}" },
      "command contains unresolved Nx placeholders",
    );
  });

  it("refuses a working directory that escapes the source workspace", async () => {
    await expectOpaque(
      { command: "node tools/test.mjs", cwd: "{projectRoot}/../../../outside" },
      "cwd escapes the source workspace",
    );
  });

  it("refuses a working directory that is absolute after placeholder resolution", async () => {
    await expectOpaque(
      { command: "node tools/test.mjs", cwd: "/opt/build" },
      "cwd must be workspace-relative after placeholder resolution",
    );
  });

  it("refuses a command with an unclosed quote", async () => {
    await expectOpaque(
      { command: "node tools/test.mjs --label 'hello world" },
      "command contains an unclosed quote",
    );
  });

  it("refuses a command that uses shell escapes", async () => {
    await expectOpaque(
      { command: "node tools/test.mjs --label hello\\ world" },
      "command uses shell escapes and cannot become standalone argv",
    );
  });

  it("refuses every form of shell control syntax", async () => {
    for (const command of [
      "npm test && npm run typecheck",
      "npm test || true",
      "npm test; npm run lint",
      "npm test | tee log",
      "echo `date`",
      "node tools/test.mjs --out $OUT",
      "node tools/test.mjs < input.txt",
      "node tools/test.mjs > out.txt",
      "node tools/test.mjs\nnode tools/lint.mjs",
    ]) {
      await expectOpaque(
        { command },
        "command uses shell control syntax and cannot become standalone argv",
      );
    }
  });

  it("refuses a command that would put Nx back on the execution path", async () => {
    for (const command of [
      "nx run app:test",
      "@nx/vite:test",
      "node_modules/nx/bin/nx.js run app:test",
      "./tools/nx run app:test",
    ]) {
      await expectOpaque(
        { command },
        "command invokes Nx and would retain a hidden Nx runtime dependency",
      );
    }
  });

  it("refuses an empty command and a target with no resolved command at all", async () => {
    await expectOpaque({ command: "   " }, "command is empty");
    await expectOpaque(
      {},
      "nx:run-commands target has no single resolved command",
    );
  });
});

/** Runs one `nx:run-commands` target through the converter against a scratch workspace. */
async function convert(options: {
  readonly command?: string;
  readonly cwd?: string;
}): Promise<Awaited<ReturnType<typeof convertTarget>>> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "dads-target-conversion-"),
  );
  workspaces.push(workspaceRoot);
  const project: NxProject = {
    name: "app",
    id: "nx-61-70-70",
    root: "apps/app",
    targets: [],
  };
  const target: NxTarget = {
    name: "test",
    id: "nx-74-65-73-74",
    executor: "nx:run-commands",
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    continuous: false,
    inferred: false,
    unresolvedExecutionFields: [],
    droppedFields: [],
  };
  return convertTarget({
    workspaceRoot,
    project,
    target,
    sourceLocation: "apps/app",
  });
}

/** Asserts one recipe produced no task and the audit naming why. */
async function expectOpaque(
  options: { readonly command?: string; readonly cwd?: string },
  reason: string,
): Promise<void> {
  const conversion = await convert(options);
  expect(conversion.task).toBeUndefined();
  expect(conversion.audit.classification).toBe("opaque");
  expect(conversion.audit.reason).toBe(reason);
}
