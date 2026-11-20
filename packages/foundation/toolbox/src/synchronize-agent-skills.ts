import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMissingPathError } from "./missing-path-error.js";

const HARNESS_DIRECTORIES = [".cursor", ".claude", ".codex"] as const;
const EXPECTED_LINK_TARGET = "../.agents/skills";

export type SkillSynchronization = {
  readonly harness: string;
  readonly status: "created" | "correct";
};

export type SkillSynchronizationInspection = {
  readonly harness: string;
  readonly skillsPath: string;
  readonly status: "missing" | "correct";
};

export function inspectAgentSkillSynchronization(
  projectRoot: string,
): readonly SkillSynchronizationInspection[] {
  return HARNESS_DIRECTORIES.map((harness) => {
    const skillsPath = join(projectRoot, harness, "skills");
    try {
      const current = lstatSync(skillsPath);
      if (!current.isSymbolicLink()) {
        throw new Error(
          `${skillsPath} is a real path; refusing to overwrite agent instructions.`,
        );
      }
      if (readlinkSync(skillsPath) !== EXPECTED_LINK_TARGET) {
        throw new Error(`${skillsPath} points to an unexpected skill source.`);
      }
      return { harness, skillsPath, status: "correct" };
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error;
      return { harness, skillsPath, status: "missing" };
    }
  });
}

export function synchronizeAgentSkills(
  projectRoot: string,
): readonly SkillSynchronization[] {
  return inspectAgentSkillSynchronization(projectRoot).map((inspection) => {
    if (inspection.status === "correct") {
      return { harness: inspection.harness, status: "correct" };
    }
    mkdirSync(dirname(inspection.skillsPath), { recursive: true });
    symlinkSync(EXPECTED_LINK_TARGET, inspection.skillsPath, "dir");
    return { harness: inspection.harness, status: "created" };
  });
}
