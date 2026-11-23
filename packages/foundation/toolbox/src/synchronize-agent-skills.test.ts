/** Proves skill synchronization never overwrites agent instructions it did not create. */

import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAgentSkillSynchronization, synchronizeAgentSkills } from "./synchronize-agent-skills.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent skill synchronization", () => {
  it("links every supported harness to the one skill source", () => {
    const projectRoot = temporaryDirectory();

    expect(synchronizeAgentSkills(projectRoot)).toEqual([
      { harness: ".cursor", status: "created" },
      { harness: ".claude", status: "created" },
      { harness: ".codex", status: "created" },
    ]);
    expect(readlinkSync(join(projectRoot, ".claude/skills"))).toBe("../.agents/skills");
    expect(synchronizeAgentSkills(projectRoot)).toEqual([
      { harness: ".cursor", status: "correct" },
      { harness: ".claude", status: "correct" },
      { harness: ".codex", status: "correct" },
    ]);
  });

  it("refuses to overwrite a real skills directory a harness already owns", () => {
    const projectRoot = temporaryDirectory();
    const skillsPath = join(projectRoot, ".claude", "skills");
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(join(skillsPath, "SKILL.md"), "# Hand written\n");

    expect(() => inspectAgentSkillSynchronization(projectRoot)).toThrow(
      `${skillsPath} is a real path; refusing to overwrite agent instructions.`,
    );
    expect(() => synchronizeAgentSkills(projectRoot)).toThrow("refusing to overwrite agent instructions");
  });

  it("refuses a skills link that points at an unexpected source", () => {
    const projectRoot = temporaryDirectory();
    const skillsPath = join(projectRoot, ".codex", "skills");
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    symlinkSync("../vendor/skills", skillsPath, "dir");

    expect(() => synchronizeAgentSkills(projectRoot)).toThrow(`${skillsPath} points to an unexpected skill source.`);
    expect(readlinkSync(skillsPath)).toBe("../vendor/skills");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-agent-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}
