import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOutputsAtomically } from "./atomic-output.js";

/**
 * The manifest and the report are one answer in two files, and two named paths
 * cannot be replaced in one filesystem step. These pin the guarantee exactly
 * as it is written down: a write failure replaces nothing, a rename failure
 * replaces the outputs before it and nothing after it, and neither leaves a
 * temporary sibling behind for the next reader to find.
 */

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeOutputsAtomically", () => {
  it("writes every output and leaves no temporary sibling behind", async () => {
    const root = await createWorkspace();

    await writeOutputsAtomically([
      { path: path.join(root, "dads.testing.json"), contents: "manifest\n" },
      { path: path.join(root, "report.json"), contents: "report\n" },
    ]);

    expect((await readdir(root)).sort()).toEqual(["dads.testing.json", "report.json"]);
    expect(await readFile(path.join(root, "report.json"), "utf8")).toBe("report\n");
  });

  it("renames nothing and removes every temporary file when one write fails", async () => {
    const root = await createWorkspace();
    const manifestPath = path.join(root, "dads.testing.json");
    const reportPath = path.join(root, "report.json");
    await writeFile(manifestPath, "previous manifest\n");
    await writeFile(reportPath, "previous report\n");

    await expect(
      writeOutputsAtomically([
        { path: manifestPath, contents: "new manifest\n" },
        {
          path: path.join(root, "absent", "report.json"),
          contents: "new report\n",
        },
      ]),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(await readFile(manifestPath, "utf8")).toBe("previous manifest\n");
    expect(await readFile(reportPath, "utf8")).toBe("previous report\n");
    expect((await readdir(root)).sort()).toEqual(["dads.testing.json", "report.json"]);
  });

  it("replaces the outputs before a failed rename and nothing after it", async () => {
    const root = await createWorkspace();
    const manifestPath = path.join(root, "dads.testing.json");
    const reportPath = path.join(root, "report.json");
    await writeFile(manifestPath, "previous manifest\n");
    // A directory in the report's place: its rename is the one that fails,
    // after the manifest's has already happened.
    await mkdir(reportPath);
    await writeFile(path.join(reportPath, "occupied"), "previous report\n");

    await expect(
      writeOutputsAtomically([
        { path: manifestPath, contents: "new manifest\n" },
        { path: reportPath, contents: "new report\n" },
      ]),
    ).rejects.toThrow();

    expect(await readFile(manifestPath, "utf8")).toBe("new manifest\n");
    expect(await readFile(path.join(reportPath, "occupied"), "utf8")).toBe("previous report\n");
    expect((await readdir(root)).sort()).toEqual(["dads.testing.json", "report.json"]);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dads-atomic-output-"));
  workspaces.push(root);
  return root;
}
