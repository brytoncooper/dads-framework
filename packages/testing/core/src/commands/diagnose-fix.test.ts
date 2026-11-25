import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { isRecord } from "../parse-guards.js";
import type { TestingDiagnoseResult } from "../testing-api.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const emptyPlan = {
  schemaVersion: 1,
  scope: { kind: "all", changedPaths: [], fullFallback: true },
  tasks: [],
  issues: [],
  complete: true,
  counts: { run: 1, skipProvenUnaffected: 0 },
};

const fixableDiagnosis: TestingDiagnoseResult = {
  schemaVersion: 1,
  summary: {
    totalModules: 25,
    totalProjects: 2,
    totalTasks: 2,
    totalTestFiles: 6,
    totalUncertainties: 2,
    wholeWorkspaceUncertainties: 0,
    unownedTrackedFiles: 6,
    nonCodeUncoveredFiles: 2,
    estimatedLeafSkipPercent: 40,
    potentialLeafSkipPercent: 90,
  },
  workspaceUncertainties: [],
  wideningCulprits: [
    {
      code: "nonliteral-dynamic-import",
      path: "packages/core/src/loader.ts",
      line: 14,
      column: 6,
      scope: "module",
      project: "core",
      message: "Dynamic import is not a string literal.",
      widenedProjects: 2,
      widenedTasks: 2,
      widenedTestFiles: 6,
      remediation: {
        safety: "safe",
        action: "Scope dynamic import.",
        caution: "Verify dynamic targets stay inside project.",
        verify: "Re-run dad-test diagnose.",
      },
    },
    {
      code: "nonliteral-commonjs-require",
      path: "packages/unknown/src/req.ts",
      line: 3,
      scope: "module",
      message: "Unowned dynamic require.",
      widenedProjects: 2,
      widenedTasks: 2,
      widenedTestFiles: 6,
      remediation: {
        safety: "safe",
        action: "Scope dynamic require.",
        caution: "Verify targets.",
        verify: "Re-run diagnose.",
      },
    },
  ],
  couplingHotspots: [],
  fallbackTraps: [
    {
      kind: "unowned-directory",
      prefix: "docs/",
      fileCount: 3,
      samplePaths: ["docs/guide.md"],
      remediation: { safety: "safe", action: "Ignore docs.", caution: "Verify.", verify: "Plan." },
    },
    {
      kind: "unowned",
      prefix: ".github/",
      fileCount: 2,
      samplePaths: [".github/workflows/ci.yml"],
      remediation: { safety: "safe", action: "Ignore CI.", caution: "Verify.", verify: "Plan." },
    },
    {
      kind: "unowned-directory",
      prefix: "./",
      fileCount: 2,
      samplePaths: ["README.md", "LICENSE", "CHANGELOG.md", "scripts/build.sh"],
      remediation: { safety: "verify-before-changing", action: "Inspect root.", caution: "Verify.", verify: "Plan." },
    },
    {
      kind: "non-code-in-reachability-project",
      prefix: "*.json in core",
      fileCount: 1,
      samplePaths: ["packages/core/fixture.json"],
      project: "core",
      remediation: {
        safety: "keep-widened-unless-verified",
        action: "Keep widened.",
        caution: "NEVER blindly ignore .json.",
        verify: "Audit.",
      },
    },
    {
      kind: "unowned-directory",
      prefix: "infra/",
      fileCount: 2,
      samplePaths: ["infra/deploy.tf"],
      remediation: {
        safety: "verify-before-changing",
        action: "Declare project.",
        caution: "Do not ignore.",
        verify: "Plan.",
      },
    },
  ],
};

const baseManifest = {
  schemaVersion: 1,
  workspace: { root: ".", fullFallback: { taskIds: ["core:test"] } },
  projects: [{ id: "core", root: "packages/core", fallbackDependencies: [] }],
  tasks: [
    {
      id: "core:test",
      project: "core",
      kind: "test",
      execution: { executable: "true", args: [] },
      dependsOn: [],
      impact: { mode: "reachability", paths: [] },
    },
  ],
};

describe("dad-test diagnose --fix", () => {
  it("previews planned safe fixes with --dry-run without modifying dads.testing.json", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "acme", dependencies: { zod: "^4.0.0", react: "^19.0.0" } }),
      "dads.testing.json": `${JSON.stringify(baseManifest, null, 2)}\n`,
    });
    const original = readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8");
    const binary = createMultiOpNativeBinary(makeTemporaryDirectory(), { diagnose: fixableDiagnosis, planOk: true });

    const human = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix", "--dry-run"], human.io)).toBe(0);
    expect(human.stderr()).toBe("");
    const output = human.stdout();
    const fixSection = output.slice(output.indexOf("diagnose --fix"));
    expect(fixSection).toContain("diagnose --fix (dry-run): 3 planned change(s) for dads.testing.json:");
    expect(fixSection).toContain("+ workspace.ignorePaths: .github/**, CHANGELOG*, LICENSE*, README.md, docs/**");
    expect(fixSection).toContain("+ workspace.pureFactories: React.forwardRef, React.memo, createContext, z.*");
    expect(fixSection).toContain('+ workspace.dynamicImportScopes: packages/core/src/loader.ts -> ["packages/core"]');
    expect(fixSection).not.toContain("fixture.json");
    expect(fixSection).not.toContain("infra/");
    expect(fixSection).not.toContain("scripts/build.sh");
    expect(fixSection).not.toContain("req.ts");
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe(original);

    const jsonHarness = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix", "--dry-run", "--json"], jsonHarness.io)).toBe(0);
    expect(JSON.parse(jsonHarness.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        summary: fixableDiagnosis.summary,
        fix: {
          manifestPath: "dads.testing.json",
          dryRun: true,
          applied: false,
          validated: false,
        },
      },
    });
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe(original);
  });

  it("validates with planTesting and atomically writes patched manifest, then stays idempotent", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "acme", dependencies: { zod: "^4.0.0" } }),
      "dads.testing.json": `${JSON.stringify(baseManifest, null, 2)}\n`,
    });
    const binary = createMultiOpNativeBinary(makeTemporaryDirectory(), { diagnose: fixableDiagnosis, planOk: true });

    const applyHarness = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix", "--json"], applyHarness.io)).toBe(0);
    expect(applyHarness.stderr()).toBe("");
    expect(JSON.parse(applyHarness.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: { fix: { dryRun: false, applied: true, validated: true } },
    });

    const patched = readJsonObject(join(workspaceRoot, "dads.testing.json"));
    expect(patched["workspace"]).toMatchObject({
      ignorePaths: [".github/**", "CHANGELOG*", "LICENSE*", "README.md", "docs/**"],
      pureFactories: ["z.*"],
      dynamicImportScopes: { "packages/core/src/loader.ts": ["packages/core"] },
    });
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
    const requests = binary.readRequests();
    expect(requests.map((req) => req["operation"])).toEqual(["diagnose", "plan"]);

    // Second run finds nothing new to apply.
    const repeatHarness = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix"], repeatHarness.io)).toBe(0);
    expect(repeatHarness.stdout()).toContain("no safe automated fixes applicable");
  });

  it("aborts without modifying dads.testing.json if candidate validation fails", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "acme", dependencies: { zod: "^4.0.0" } }),
      "dads.testing.json": `${JSON.stringify(baseManifest, null, 2)}\n`,
    });
    const original = readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8");
    const binary = createMultiOpNativeBinary(makeTemporaryDirectory(), {
      diagnose: fixableDiagnosis,
      planOk: false,
      planError: "Invalid dynamicImportScopes prefix.",
    });

    const harness = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix"], harness.io)).toBe(1);
    expect(harness.stderr()).toContain("diagnose --fix aborted: candidate manifest failed validation");
    expect(harness.stderr()).toContain("Original dads.testing.json was not modified.");
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe(original);
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
  });

  it("refuses --fix without a manifest, refuses manifest-less Nx mode, and refuses --dry-run without --fix", async () => {
    const emptyDir = makeTemporaryDirectory();
    const binary = createMultiOpNativeBinary(makeTemporaryDirectory(), { diagnose: fixableDiagnosis, planOk: true });

    const missingManifest = createHarness(emptyDir, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix"], missingManifest.io)).toBe(1);
    expect(missingManifest.stderr()).toContain("diagnose --fix requires an existing dads.testing.json manifest");

    const nxDir = makeWorkspace({ "nx.json": "{}\n" });
    const nxHarness = createHarness(nxDir, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix"], nxHarness.io)).toBe(1);
    expect(nxHarness.stderr()).toContain("manifest-less Nx mode");

    const dryOnly = createHarness(emptyDir, binary.binary);
    expect(await runDadTestCli(["diagnose", "--dry-run"], dryOnly.io)).toBe(1);
    expect(dryOnly.stderr()).toContain("--dry-run requires --fix.");
  });

  it("preserves workspace.discover when patching a declarative manifest", async () => {
    const discoverManifest = {
      schemaVersion: 1,
      workspace: {
        root: ".",
        discover: { projectFiles: ["packages/*/package.json"], targetTemplates: [] },
      },
    };
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "acme", dependencies: { valibot: "^1.0.0" } }),
      "dads.testing.json": `${JSON.stringify(discoverManifest, null, 2)}\n`,
    });
    const binary = createMultiOpNativeBinary(makeTemporaryDirectory(), {
      diagnose: { ...fixableDiagnosis, wideningCulprits: [] },
      planOk: true,
    });

    const harness = createHarness(workspaceRoot, binary.binary);
    expect(await runDadTestCli(["diagnose", "--fix"], harness.io)).toBe(0);

    const patched = readJsonObject(join(workspaceRoot, "dads.testing.json"));
    expect(patched["workspace"]).toMatchObject({
      pureFactories: ["v.*"],
      discover: { projectFiles: ["packages/*/package.json"], targetTemplates: [] },
    });
  });
});

function createMultiOpNativeBinary(
  directory: string,
  config: { readonly diagnose: TestingDiagnoseResult; readonly planOk: boolean; readonly planError?: string },
): { readonly binary: string; readonly readRequests: () => readonly Record<string, unknown>[] } {
  const binary = join(directory, "multi-native-binary.mjs");
  const logPath = join(directory, "requests.jsonl");
  const planResponse = config.planOk
    ? { schemaVersion: 1, ok: true, result: { operation: "plan", plan: emptyPlan } }
    : { schemaVersion: 1, ok: false, error: config.planError ?? "Plan rejected." };
  const diagnoseResponse = {
    schemaVersion: 1,
    ok: true,
    result: { operation: "diagnose", plan: emptyPlan, diagnose: config.diagnose },
  };
  const source = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { raw += chunk; });',
    'process.stdin.on("end", () => {',
    "  const req = JSON.parse(raw);",
    `  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(req) + "\\n", "utf8");`,
    `  const resp = req.operation === "plan" ? ${JSON.stringify(planResponse)} : ${JSON.stringify(diagnoseResponse)};`,
    '  process.stdout.write(JSON.stringify(resp) + "\\n");',
    "});",
    "",
  ].join("\n");
  writeFileSync(binary, source, "utf8");
  chmodSync(binary, 0o755);
  return {
    binary,
    readRequests: () =>
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) throw new Error("Expected request object.");
          return parsed;
        }),
  };
}

function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory();
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-diagnose-fix-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryFilesIn(directory: string): readonly string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Expected JSON object in ${filePath}`);
  return parsed;
}

function createHarness(
  cwd: string,
  nativeBinary: string,
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: DadTestCliIo = {
    cwd,
    env: {},
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
    nativeBinary,
  };
  return { io, stdout: () => stdoutChunks.join(""), stderr: () => stderrChunks.join("") };
}
