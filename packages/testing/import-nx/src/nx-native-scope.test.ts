import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { requireNativeNxScope } from "./nx-native-scope.js";

/**
 * A live Nx graph describes the checkout, never a different historical head.
 * The adapter therefore refuses every scope whose answer the graph it is about
 * to collect could not support.
 */

const run = promisify(execFile);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("requireNativeNxScope", () => {
  it("accepts a working-tree scope and an --all scope without a revision", async () => {
    const workspaceRoot = await createRepository();

    await expect(
      requireNativeNxScope({ workspaceRoot }),
    ).resolves.toBeUndefined();
    await expect(
      requireNativeNxScope({ workspaceRoot, all: true }),
    ).resolves.toBeUndefined();
  });

  it("refuses --all combined with --base or --head", async () => {
    const workspaceRoot = await createRepository();

    await expect(
      requireNativeNxScope({ workspaceRoot, all: true, base: "HEAD~1" }),
    ).rejects.toThrow("--all cannot be combined with --base or --head.");
    await expect(
      requireNativeNxScope({ workspaceRoot, all: true, head: "HEAD" }),
    ).rejects.toThrow("--all cannot be combined with --base or --head.");
  });

  it("refuses --head without --base", async () => {
    const workspaceRoot = await createRepository();

    await expect(
      requireNativeNxScope({ workspaceRoot, head: "HEAD" }),
    ).rejects.toThrow("--head requires --base.");
  });

  it("accepts a --head that is the clean checked-out HEAD", async () => {
    const workspaceRoot = await createRepository();

    await expect(
      requireNativeNxScope({ workspaceRoot, base: "HEAD", head: "HEAD" }),
    ).resolves.toBeUndefined();
  });

  it("refuses a --head that names a revision other than the checked-out HEAD", async () => {
    const workspaceRoot = await createRepository();
    await writeFile(
      path.join(workspaceRoot, "second.ts"),
      "export const b = 2;\n",
    );
    await run("git", ["add", "."], { cwd: workspaceRoot });
    await run("git", ["commit", "-qm", "second"], { cwd: workspaceRoot });

    await expect(
      requireNativeNxScope({ workspaceRoot, base: "HEAD~1", head: "HEAD~1" }),
    ).rejects.toThrow(
      "Nx --head planning requires that revision to be the clean checked-out HEAD",
    );
  });

  it("refuses a --head at HEAD when the working tree is dirty", async () => {
    const workspaceRoot = await createRepository();
    await writeFile(
      path.join(workspaceRoot, "source.ts"),
      "export const a = 2;\n",
    );

    await expect(
      requireNativeNxScope({ workspaceRoot, base: "HEAD", head: "HEAD" }),
    ).rejects.toThrow(
      "Nx --head planning requires that revision to be the clean checked-out HEAD",
    );
  });
});

async function createRepository(): Promise<string> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "dads-native-scope-"),
  );
  workspaces.push(workspaceRoot);
  await writeFile(
    path.join(workspaceRoot, "source.ts"),
    "export const a = 1;\n",
  );
  await run("git", ["init", "-q"], { cwd: workspaceRoot });
  await run("git", ["config", "user.email", "test@example.invalid"], {
    cwd: workspaceRoot,
  });
  await run("git", ["config", "user.name", "Dads Test"], {
    cwd: workspaceRoot,
  });
  await run("git", ["add", "."], { cwd: workspaceRoot });
  await run("git", ["commit", "-qm", "fixture"], { cwd: workspaceRoot });
  return workspaceRoot;
}
