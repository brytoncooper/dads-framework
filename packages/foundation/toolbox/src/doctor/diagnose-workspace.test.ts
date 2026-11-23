/**
 * Proves the library form of `dad doctor` answers with a report rather than an
 * exit code, and reports a signal that could not answer instead of throwing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseWorkspace } from "./diagnose-workspace.js";
import { DADDY_ISSUES } from "./issues.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("diagnose workspace", () => {
  it("reports every issue in essay order for a directory that adopted nothing", async () => {
    const root = workspaceWithOneFile();

    const report = await diagnoseWorkspace({ root });

    expect(report.ok).toBe(true);
    expect(report.profile).toBe("standard");
    expect(report.today).toBeNull();
    expect(report.issues.map((issue) => issue.id)).toEqual(DADDY_ISSUES.map((issue) => issue.id));
  });

  it("narrows to the named issues and refuses an id nothing carries", async () => {
    const root = workspaceWithOneFile();

    const report = await diagnoseWorkspace({
      root,
      issues: ["enmeshment", "daddy-issues"],
      profile: "strict",
      today: "2026-09-07",
    });

    expect(report.issues.map((issue) => issue.id)).toEqual(["daddy-issues", "enmeshment"]);
    expect(report.profile).toBe("strict");
    expect(report.today).toBe("2026-09-07");
    await expect(diagnoseWorkspace({ root, issues: ["separation-anxiety"] })).rejects.toThrow(
      "No daddy issue is named separation-anxiety.",
    );
  });

  it("records a signal that could not answer as a line rather than a failure", async () => {
    const root = workspaceWithOneFile();

    const report = await diagnoseWorkspace({ root });

    const signals = report.issues.flatMap((issue) => issue.signals);
    const unmeasured = signals.filter((signal) => signal.state === "not measured");
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const signal of unmeasured) {
      expect(signal.failure).toBeTypeOf("string");
    }
  });
});

/** A directory with one hand-written file and no TypeScript project in it. */
function workspaceWithOneFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "diagnose-workspace-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "README.md"), "# host\n");
  return directory;
}
