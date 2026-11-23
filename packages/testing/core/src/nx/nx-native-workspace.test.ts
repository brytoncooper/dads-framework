import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { planNativeNxTesting, runNativeNxTesting } from "./nx-native-workspace.js";

const run = promisify(execFile);
const temporaryWorkspaces: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("native Nx workspace wrapper", () => {
  it("discovers the graph through Nx and sends an in-workspace manifest to Dads", async () => {
    const workspace = await createWorkspace();
    const result = await planNativeNxTesting({
      workspaceRoot: workspace,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      targetNames: ["test"],
    });

    expect(result.coverage.registered).toBe(1);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.tasks[0]?.id).toContain("nx-61-70-70");
  });

  it("refreshes target inventory on every call", async () => {
    const workspace = await createWorkspace();
    const first = await planNativeNxTesting({
      workspaceRoot: workspace,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
    });
    expect(first.coverage.registered).toBe(1);
    await writeFile(path.join(workspace, "graph-definition.json"), graphDefinition(2));
    const second = await planNativeNxTesting({
      workspaceRoot: workspace,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
    });
    expect(second.coverage.registered).toBe(2);
  });

  it("cleans scratch after graph failure and rejects source mutation before native", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, "graph-definition.json"), graphDefinition(1, true));
    await expect(
      planNativeNxTesting({
        workspaceRoot: workspace,
        nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      }),
    ).rejects.toThrow("workspace changed during Nx discovery");
    await expect(readFile(path.join(workspace, "native-called"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(workspace, "node_modules", ".cache", "dads-testing"))).toEqual([]);
    await writeFile(path.join(workspace, "graph-definition.json"), '{"invalid":');
    await expect(
      planNativeNxTesting({
        workspaceRoot: workspace,
        nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      }),
    ).rejects.toThrow();
    expect(await readdir(path.join(workspace, "node_modules", ".cache", "dads-testing"))).toEqual([]);
  });

  it("requires the scratch directory itself to be ignored", async () => {
    const workspace = await createWorkspace("manifest.json\nnode_modules/nx/\n");
    await expect(
      planNativeNxTesting({
        workspaceRoot: workspace,
        nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      }),
    ).rejects.toThrow("needs an ignored scratch directory");
  });

  it("returns the Nx coverage, the plan, and the run results of a still workspace", async () => {
    const workspace = await createWorkspace(undefined, false);

    const result = await runNativeNxTesting({
      workspaceRoot: workspace,
      nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
      targetNames: ["test"],
    });

    expect(result.coverage.registered).toBe(1);
    expect(result.plan.tasks[0]?.id).toBe("nx-61-70-70:nx-74-65-73-74");
    expect(result.run?.tasks[0]?.status).toBe("executed");
    expect(result.run?.counts).toEqual({
      executed: 1,
      failed: 0,
      blocked: 0,
      notApplicable: 0,
    });
    expect(result.run?.exitCode).toBe(0);
    expect(await readdir(path.join(workspace, "node_modules", ".cache", "dads-testing"))).toEqual([]);
  });

  it("rejects a workspace changed by the native run", async () => {
    const workspace = await createWorkspace();
    await expect(
      runNativeNxTesting({
        workspaceRoot: workspace,
        nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
        targetNames: ["test"],
      }),
    ).rejects.toThrow("workspace changed during Nx discovery, planning, or execution");
  });
});

async function createWorkspace(gitignore = "tmp/\nnode_modules/\n", mutateOnRun = true): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "dads-testing-native-workspace-"));
  temporaryWorkspaces.push(workspace);
  await writeFile(path.join(workspace, ".gitignore"), gitignore);
  await writeFile(path.join(workspace, "nx.json"), '{"namedInputs":{"default":["{projectRoot}/**/*"]}}\n');
  await writeFile(path.join(workspace, "graph-definition.json"), graphDefinition(1));
  await writeFile(path.join(workspace, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(workspace, "source.ts"), "export const value = 1;\n");
  await writeFile(path.join(workspace, "fake-dad-test.mjs"), fakeDadTestSource(mutateOnRun));
  await chmod(path.join(workspace, "fake-dad-test.mjs"), 0o755);
  await writeFile(path.join(workspace, "nx-cli.mjs"), fakeNxSource());
  await chmod(path.join(workspace, "nx-cli.mjs"), 0o755);
  await run("git", ["init", "-q"], { cwd: workspace });
  await run("git", ["config", "user.email", "test@example.invalid"], {
    cwd: workspace,
  });
  await run("git", ["config", "user.name", "Dads Test"], { cwd: workspace });
  await run("git", ["add", "."], { cwd: workspace });
  await run("git", ["commit", "-qm", "fixture"], { cwd: workspace });
  const nxDirectory = path.join(workspace, "node_modules", "nx");
  await mkdir(path.join(nxDirectory, "bin"), { recursive: true });
  await writeFile(path.join(nxDirectory, "bin", "nx.mjs"), fakeNxSource());
  await chmod(path.join(nxDirectory, "bin", "nx.mjs"), 0o755);
  await writeFile(path.join(nxDirectory, "package.json"), '{"name":"nx","bin":{"nx":"./bin/nx.mjs"}}\n');
  await writeFile(path.join(workspace, "node_modules", ".package-lock.json"), "{}\n");
  return workspace;
}

function fakeNxSource(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const file = process.argv.find((value) => value.startsWith("--file="));
if (!process.argv.includes("graph") || !file || process.argv.includes("show")) process.exit(9);
const definition = JSON.parse(readFileSync(path.join(process.cwd(), "graph-definition.json"), "utf8"));
writeFileSync(file.slice("--file=".length), JSON.stringify(definition.graph));
if (definition.mutate === true) writeFileSync(path.join(process.cwd(), "source.ts"), "export const value = 2;\\n");
`;
}

function fakeDadTestSource(mutateOnRun: boolean): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (!request.manifestPath || request.manifestPath.startsWith("/")) process.exit(10);
if (readFileSync(path.join(request.workspaceRoot, "source.ts"), "utf8").includes("value = 2")) writeFileSync(path.join(request.workspaceRoot, "native-called"), "yes");
if (${String(mutateOnRun)} && request.operation === "run") writeFileSync(path.join(request.workspaceRoot, "source.ts"), "export const value = 3;\\n");
const operation = request.operation === "run" ? { run: { tasks: [{ id: "nx-61-70-70:nx-74-65-73-74", status: "executed" }], counts: { executed: 1, failed: 0, blocked: 0, notApplicable: 0 }, exitCode: 0 } } : {};
process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { operation: request.operation, plan: { schemaVersion: 1, scope: { kind: "working-tree", changedPaths: [], fullFallback: false }, tasks: [{ id: "nx-61-70-70:nx-74-65-73-74", decision: "run", reason: "impact-always", confidence: "explicit", widened: false, project: "nx-61-70-70" }], issues: [], complete: true, counts: { run: 1, skipProvenUnaffected: 0 } }, ...operation } }));
`;
}

function graphDefinition(targetCount: number, mutate = false): string {
  const targets: Record<string, unknown> = {};
  for (let index = 1; index <= targetCount; index += 1)
    targets[index === 1 ? "test" : `test:${String(index)}`] = {
      executor: "nx:run-commands",
      options: { command: "true" },
    };
  return JSON.stringify({
    graph: {
      nodes: {
        app: { name: "app", data: { name: "app", root: ".", targets } },
      },
      dependencies: { app: [] },
    },
    ...(mutate ? { mutate: true } : {}),
  });
}
