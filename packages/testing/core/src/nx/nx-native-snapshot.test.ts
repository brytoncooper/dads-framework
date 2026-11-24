import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseNativeNxTesting, planNativeNxTesting, runNativeNxTesting } from "./nx-native-workspace.js";

const runGit = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ephemeral Git worktree snapshots for Nx", () => {
  it("diagnoses HEAD cleanly inside a temporary worktree even while the live checkout is dirty", async () => {
    const workspace = await createSnapshotFixture();
    await writeFile(path.join(workspace, "source.ts"), "export const dirtyLiveEdit = true;\n");
    await writeFile(path.join(workspace, "graph-definition.json"), '{"broken":');

    const result = await diagnoseNativeNxTesting({
      workspaceRoot: workspace,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      targetNames: ["test"],
    });

    expect(result.coverage.registered).toBe(1);
    expect(result.diagnose.summary.totalProjects).toBe(1);
    expect(await listWorktrees(workspace)).toHaveLength(1);
  });

  it("plans --base A --head B against a historical commit on a dirty checkout and cleans up the worktree", async () => {
    const workspace = await createSnapshotFixture();
    const firstCommit = (await runGit("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
    await writeFile(path.join(workspace, "source.ts"), "export const value = 2;\n");
    await runGit("git", ["add", "source.ts"], { cwd: workspace });
    await runGit("git", ["commit", "-qm", "second"], { cwd: workspace });
    const secondCommit = (await runGit("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();

    await writeFile(path.join(workspace, "source.ts"), "export const value = 3;\n");
    await runGit("git", ["add", "source.ts"], { cwd: workspace });
    await runGit("git", ["commit", "-qm", "third"], { cwd: workspace });

    await writeFile(path.join(workspace, "source.ts"), "export const dirty = 999;\n");

    const result = await planNativeNxTesting({
      workspaceRoot: workspace,
      base: firstCommit,
      head: secondCommit,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      targetNames: ["test"],
    });

    expect(result.coverage.registered).toBe(1);
    const recorded: unknown = JSON.parse(await readFile(path.join(workspace, "recorded-request.json"), "utf8"));
    expect(recorded).toMatchObject({
      base: firstCommit,
      head: secondCommit,
      sourceContent: "export const value = 2;\n",
    });
    expect(recorded).not.toMatchObject({ workspaceRoot: workspace });
    expect(await listWorktrees(workspace)).toHaveLength(1);
  });

  it("plans --snapshot against HEAD on a dirty checkout and refuses --snapshot on run", async () => {
    const workspace = await createSnapshotFixture();
    const headSha = (await runGit("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
    await writeFile(path.join(workspace, "source.ts"), "export const dirtyEdit = true;\n");

    const result = await planNativeNxTesting({
      workspaceRoot: workspace,
      base: headSha,
      snapshot: true,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      targetNames: ["test"],
    });

    expect(result.coverage.registered).toBe(1);
    const recorded: unknown = JSON.parse(await readFile(path.join(workspace, "recorded-request.json"), "utf8"));
    expect(recorded).toMatchObject({
      head: headSha,
      sourceContent: "export const value = 1;\n",
    });
    expect(await listWorktrees(workspace)).toHaveLength(1);

    await expect(
      runNativeNxTesting({
        workspaceRoot: workspace,
        snapshot: true,
        nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      }),
    ).rejects.toThrow("--snapshot is only supported for plan");
  });
});

async function listWorktrees(workspace: string): Promise<string[]> {
  const { stdout } = await runGit("git", ["worktree", "list", "--porcelain"], { cwd: workspace });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function createSnapshotFixture(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "dads-testing-nx-snapshot-fixture-"));
  tempRoots.push(workspace);
  await writeFile(path.join(workspace, ".gitignore"), "node_modules/\nrecorded-request.json\n");
  await writeFile(path.join(workspace, "nx.json"), '{"namedInputs":{"default":["{projectRoot}/**/*"]}}\n');
  await writeFile(
    path.join(workspace, "graph-definition.json"),
    JSON.stringify({
      graph: {
        nodes: {
          app: {
            name: "app",
            data: {
              name: "app",
              root: ".",
              targets: { test: { executor: "nx:run-commands", options: { command: "true" } } },
            },
          },
        },
        dependencies: { app: [] },
      },
    }),
  );
  await writeFile(path.join(workspace, "package.json"), '{"name":"snapshot-fixture"}\n');
  await writeFile(path.join(workspace, "source.ts"), "export const value = 1;\n");
  const recordPath = path.join(workspace, "recorded-request.json");
  await writeFile(path.join(workspace, "fake-dad-test.mjs"), fakeSnapshotNativeBinary(recordPath));
  await chmod(path.join(workspace, "fake-dad-test.mjs"), 0o755);

  await runGit("git", ["init", "-q"], { cwd: workspace });
  await runGit("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await runGit("git", ["config", "user.name", "Dads Test"], { cwd: workspace });
  await runGit("git", ["add", "."], { cwd: workspace });
  await runGit("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const nxDir = path.join(workspace, "node_modules", "nx");
  await mkdir(path.join(nxDir, "bin"), { recursive: true });
  await writeFile(path.join(nxDir, "bin", "nx.mjs"), fakeSnapshotNxBinary());
  await chmod(path.join(nxDir, "bin", "nx.mjs"), 0o755);
  await writeFile(path.join(nxDir, "package.json"), '{"name":"nx","bin":{"nx":"./bin/nx.mjs"}}\n');
  return workspace;
}

function fakeSnapshotNxBinary(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const file = process.argv.find((value) => value.startsWith("--file="));
if (!process.argv.includes("graph") || !file) process.exit(9);
const definition = JSON.parse(readFileSync(path.join(process.cwd(), "graph-definition.json"), "utf8"));
writeFileSync(file.slice("--file=".length), JSON.stringify(definition.graph));
`;
}

function fakeSnapshotNativeBinary(recordPath: string): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sourceContent = readFileSync(path.join(request.workspaceRoot, "source.ts"), "utf8");
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ workspaceRoot: request.workspaceRoot, base: request.base, head: request.head, sourceContent }));
const extra = request.operation === "diagnose"
  ? { diagnose: { schemaVersion: 1, summary: { totalModules: 1, totalProjects: 1, totalTasks: 1, totalTestFiles: 0, totalUncertainties: 0, wholeWorkspaceUncertainties: 0, unownedTrackedFiles: 0, nonCodeUncoveredFiles: 0, estimatedLeafSkipPercent: 0, potentialLeafSkipPercent: 0 }, wideningCulprits: [], couplingHotspots: [], fallbackTraps: [] } }
  : {};
process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { operation: request.operation, plan: { schemaVersion: 1, scope: { kind: "git-range", changedPaths: [], fullFallback: false }, tasks: [{ id: "app:test", decision: "run", reason: "impact-always", confidence: "explicit", widened: false, project: "app" }], issues: [], complete: true, counts: { run: 1, skipProvenUnaffected: 0 } }, ...extra } }));
`;
}
