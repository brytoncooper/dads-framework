import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestInputs, digestProjectInputs, sha256 } from "./import-digest.js";

/**
 * The evidence an import was taken over one exact set of bytes. A file that is
 * simply absent is not evidence of anything and is skipped; any other read
 * failure is a real failure and must be raised rather than recorded as "no
 * input".
 */

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("import digest", () => {
  it("hashes bytes with SHA-256", () => {
    expect(sha256("dads")).toBe(createHash("sha256").update("dads").digest("hex"));
    expect(sha256(new Uint8Array([1, 2, 3]))).toBe(
      createHash("sha256")
        .update(new Uint8Array([1, 2, 3]))
        .digest("hex"),
    );
  });

  it("digests only the workspace files that exist, in the order the report lists them", async () => {
    const root = await createWorkspace();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    await writeFile(path.join(root, "nx.json"), "{}\n");
    await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');

    const inputs = await digestInputs(root);

    expect(inputs.map((input) => input.path)).toEqual(["package-lock.json", "nx.json", "package.json"]);
    expect(inputs[0]?.sha256).toBe(sha256("{}\n"));
  });

  it("records no input for a workspace that declares none of them", async () => {
    expect(await digestInputs(await createWorkspace())).toEqual([]);
  });

  it("adds each project's own configuration once and returns the whole set sorted by path", async () => {
    const root = await createWorkspace();
    await writeFile(path.join(root, "package.json"), '{"name":"root"}\n');
    await mkdir(path.join(root, "apps/app"), { recursive: true });
    await writeFile(path.join(root, "apps/app/project.json"), '{"name":"app"}\n');
    await writeFile(path.join(root, "apps/app/package.json"), '{"name":"app"}\n');
    const rootInputs = await digestInputs(root);

    const inputs = await digestProjectInputs(root, rootInputs, ["apps/app", ".", "libs/absent"]);

    expect(inputs.map((input) => input.path)).toEqual([
      "apps/app/package.json",
      "apps/app/project.json",
      "package.json",
    ]);
    expect(inputs.filter((input) => input.path === "package.json")).toHaveLength(1);
  });

  it("raises a read failure that is not a missing file", async () => {
    const root = await createWorkspace();
    await mkdir(path.join(root, "nx.json"));

    await expect(digestInputs(root)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dads-import-digest-"));
  workspaces.push(root);
  return root;
}
