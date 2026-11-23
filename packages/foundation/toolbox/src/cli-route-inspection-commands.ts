import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { writeOutput } from "./cli-io.js";
import { loadDadsProject } from "./project-files.js";
import { readRouteSource } from "./route-inspection/read-route-source.js";

export function inspect(subject: string | undefined, operation: string | undefined, json: boolean): void {
  if (subject !== "http-operation" || !operation) {
    throw new Error('inspect requires http-operation "<METHOD /path>".');
  }
  const { root } = loadDadsProject(process.cwd());
  const operations = listTypeScriptFiles(root).flatMap((file) => {
    const filename = relative(root, file);
    return readRouteSource(readFileSync(file, "utf8"), filename)
      .filter((entry) => entry.operation === operation || `${entry.method} ${entry.routePath}` === operation)
      .map((entry) => ({
        file: filename,
        operation: entry.operation,
        method: entry.method,
        path: entry.routePath,
        line: entry.line,
        schemas: entry.schemas,
        declaresAccess: entry.declaresAccess,
      }));
  });
  if (operations.length === 0) {
    throw new Error(`No literal HTTP operation named ${operation} was found.`);
  }
  writeOutput({ ok: true, operations }, json);
}

function listTypeScriptFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || ignored.has(entry.name)) return [];
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && regularSource.test(entry.name) ? [path] : [];
  });
}

const ignored = new Set(["node_modules", "dist", "target", "coverage"]);
const regularSource = /(?<!\.test)\.tsx?$/;
