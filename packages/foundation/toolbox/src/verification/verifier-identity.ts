import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function readVerifierIdentity(): string {
  return deriveVerifierIdentity(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function deriveVerifierIdentity(toolboxRoot: string): string {
  const files = listToolboxFiles(toolboxRoot).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const projectPath = relative(toolboxRoot, file).split(sep).join("/");
    const contents = readFileSync(file);
    hash.update(`${projectPath}\0${String(contents.byteLength)}\0`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

function listToolboxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return [];
    if (entry.isDirectory()) return listToolboxFiles(path);
    if (!entry.isFile() || !isToolboxImplementation(entry.name)) return [];
    return [path];
  });
}

function isToolboxImplementation(fileName: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(fileName)) return false;
  if (fileName.endsWith(".d.ts") || fileName.endsWith(".map")) return false;
  return /\.[cm]?[jt]s$/.test(fileName);
}
