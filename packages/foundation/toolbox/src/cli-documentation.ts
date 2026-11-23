import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolboxReadme = fileURLToPath(new URL("../README.md", import.meta.url));

export function commandDocumentation(root: string, ...projectPaths: string[]): string {
  const options = projectPaths.map((path) => resolve(root, path));
  return options.find((path) => existsSync(path)) ?? toolboxReadme;
}

export function documentedError(error: unknown, documentation: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\nSee ${documentation}`, { cause: error });
}
