import { relative, sep } from "node:path";

/**
 * One spelling for a path inside the workspace.
 *
 * The inventory keys packages by it, and the manifest writer reports the files
 * it wrote by it. Two spellings of one directory — a Windows separator here and
 * a `/` there — would leave a resolved reference failing to match the package
 * the inventory already holds.
 */

/** `target` as a `/`-separated path relative to `workspaceRoot`, or `.` for the root. */
export function workspaceRelative(workspaceRoot: string, target: string): string {
  const relativePath = relative(workspaceRoot, target);
  if (relativePath === "") return ".";
  return relativePath.split(sep).join("/");
}
