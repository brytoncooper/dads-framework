/**
 * The access artifacts a workspace holds, and the package each belongs to.
 *
 * An access artifact is a `.zed` schema the access kit emitted from the
 * package's TypeScript access declarations, recognised by the banner the kit
 * writes on its first line. A `.zed` without the banner is somebody's
 * hand-written schema or a test specimen, and is nobody's generated output.
 *
 * The package is the declared one whose root holds the artifact, the directory
 * above its `src/` when nothing is declared, and its own directory otherwise —
 * the same answer the TypeScript program gives a module, so an artifact and
 * the declarations it came from are read as one package.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { isAccessKitArtifact } from "./generated-artifacts.js";

const SCHEMA_SUFFIX = ".zed";
const SOURCE_MARKER = "/src/";

/** True for a path that could hold an access schema. */
export function isSchemaPath(path: string): boolean {
  return path.endsWith(SCHEMA_SUFFIX);
}

/** The package root that owns a path, by the rule this module describes. */
export function owningRoot(
  path: string,
  declaredRoots: readonly string[],
): string {
  const declared = declaredRoots
    .filter((root) => root.length > 0 && path.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (declared !== undefined) return declared;
  const marker = path.indexOf(SOURCE_MARKER);
  if (marker !== -1) return path.slice(0, marker);
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** The package roots the workspace declares. */
export function declaredRootsOf(context: DoctorContext): readonly string[] {
  return context.packages().map((declared) => declared.root);
}

/** Every access artifact in the tree, by path. */
export function accessArtifacts(context: DoctorContext): readonly string[] {
  return context
    .files()
    .filter(
      (path) =>
        isSchemaPath(path) &&
        context.exists(path) &&
        isAccessKitArtifact(context.read(path)),
    );
}
