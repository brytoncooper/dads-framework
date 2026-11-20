import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);

describe("dad test composition", () => {
  it("advertises the standalone testing commands in help", () => {
    const result = runDad(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test plan|run|explain|init");
  });

  it("forwards test arguments through the public testing package", () => {
    const directory = mkdtempSync(join(tmpdir(), "dad-test-toolbox-"));
    const nativeBinary = join(directory, "native.mjs");
    const captured = join(directory, "request.json");
    writeFileSync(
      nativeBinary,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nlet input = ""; process.stdin.on("data", chunk => input += chunk).on("end", () => { fs.writeFileSync(${JSON.stringify(captured)}, input); process.stdout.write(JSON.stringify({schemaVersion:1,ok:true,result:{operation:"plan",plan:{schemaVersion:1,scope:{kind:"all",changedPaths:[],fullFallback:true},tasks:[],issues:[],complete:true,counts:{run:0,skipProvenUnaffected:0}}}})); });\n`,
    );
    chmodSync(nativeBinary, 0o755);
    try {
      const result = runDad(
        [
          "test",
          "plan",
          "--manifest",
          "ci/tasks.json",
          "--base",
          "origin/main",
          "--head",
          "HEAD",
          "--task",
          "api:test",
          "--task",
          "ui:test",
          "--jobs",
          "3",
          "--json",
        ],
        { DADS_TEST_NATIVE_BINARY: nativeBinary },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(captured, "utf8"))).toMatchObject({
        operation: "plan",
        manifestPath: "ci/tasks.json",
        base: "origin/main",
        head: "HEAD",
        taskIds: ["api:test", "ui:test"],
        jobs: 3,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("explains a plan through the standalone testing CLI", () => {
    const directory = createTestingWorkspace();
    try {
      const result = runDad(
        ["test", "explain", "--all", "--json"],
        { DADS_TEST_NATIVE_BINARY: join(directory, "native.mjs") },
        directory,
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        result: {
          tasks: [{ id: "consumer:test" }],
          summary: { selected: 1 },
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes a plan report through the standalone testing CLI", () => {
    const directory = createTestingWorkspace();
    const reportPath = join(directory, "report.json");
    try {
      const result = runDad(
        ["test", "plan", "--all", "--report", reportPath, "--json"],
        { DADS_TEST_NATIVE_BINARY: join(directory, "native.mjs") },
        directory,
      );
      expect(result.status).toBe(0);
      expect(existsSync(reportPath)).toBe(true);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        result: { report: { projectClosure: { closureTaskCount: 1 } } },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * A temporary workspace whose manifest declares one task and whose stub engine
 * always plans that task, so `explain` and `--report` are exercised end to end
 * without a built native binary.
 */
function createTestingWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "dad-test-toolbox-"));
  writeFileSync(
    join(directory, "dads.testing.json"),
    JSON.stringify({
      schemaVersion: 1,
      workspace: { root: ".", fullFallback: { taskIds: ["consumer:test"] } },
      projects: [{ id: "consumer", root: ".", fallbackDependencies: [] }],
      tasks: [
        {
          id: "consumer:test",
          project: "consumer",
          kind: "test",
          execution: { executable: "node", args: ["--version"], cwd: "." },
          dependsOn: [],
          impact: { mode: "always" },
        },
      ],
    }),
  );
  const plannedResponse = {
    schemaVersion: 1,
    ok: true,
    result: {
      operation: "plan",
      plan: {
        schemaVersion: 1,
        scope: { kind: "all", changedPaths: [], fullFallback: true },
        tasks: [
          {
            id: "consumer:test",
            project: "consumer",
            decision: "run",
            reason: "impact-always",
            confidence: "complete",
          },
        ],
        issues: [],
        complete: true,
        counts: { run: 1, skipProvenUnaffected: 0 },
      },
    },
  };
  const nativeBinary = join(directory, "native.mjs");
  writeFileSync(
    nativeBinary,
    `#!/usr/bin/env node\nprocess.stdin.on("data", () => {}).on("end", () => { process.stdout.write(${JSON.stringify(JSON.stringify(plannedResponse))}); });\n`,
  );
  chmodSync(nativeBinary, 0o755);
  return directory;
}

function runDad(
  argumentsToPass: readonly string[],
  env?: Record<string, string>,
  cwd?: string,
) {
  return spawnSync(
    process.execPath,
    [join(packageDirectory, "bin", "dad.js"), ...argumentsToPass],
    {
      cwd: cwd ?? join(packageDirectory, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}
