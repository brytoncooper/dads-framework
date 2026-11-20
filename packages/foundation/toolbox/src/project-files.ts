import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDadsProject, type DadsProject } from "./project-orientation.js";

const PROJECT_FILENAME = "dads.project.json";

export type LoadedDadsProject = {
  readonly root: string;
  readonly project: DadsProject;
};

export function loadDadsProject(startPath: string): LoadedDadsProject {
  const root = findDadsProjectRoot(startPath);
  const projectPath = join(root, PROJECT_FILENAME);
  const parsedJson: unknown = JSON.parse(readFileSync(projectPath, "utf8"));
  return { root, project: parseDadsProject(parsedJson) };
}

export function findDadsProjectRoot(startPath: string): string {
  let candidate = resolve(startPath);
  while (dirname(candidate) !== candidate) {
    if (existsSync(join(candidate, PROJECT_FILENAME))) {
      return candidate;
    }
    candidate = dirname(candidate);
  }
  if (existsSync(join(candidate, PROJECT_FILENAME))) {
    return candidate;
  }
  throw new Error(`Could not find ${PROJECT_FILENAME} from ${startPath}.`);
}
