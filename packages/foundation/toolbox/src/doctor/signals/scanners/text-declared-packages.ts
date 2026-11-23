/**
 * The packages a repository declares, read from the project file's text.
 *
 * The two documentation readings ask their question of the packages a
 * repository has named, not of every directory that happens to hold a
 * manifest. A repository that has not declared its packages is asked nothing
 * here — `kinds-undeclared` is the reading that notices that absence — because
 * a doctor that invented a package list would then report every directory it
 * guessed at as an undocumented package.
 *
 * This reads one file and returns what it says. The richer package graph, with
 * dependency edges and a manifest fallback, is `context.packages()`, and the
 * lanes whose signals need edges read it there.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

/** Where a repository that has adopted Dads names its packages. */
export const PROJECT_DECLARATION = "dads.project.json";

/** One declared package: the three fields a text reading needs. */
export type DeclaredPackage = {
  readonly name: string;
  readonly root: string;
  readonly kind: string | undefined;
};

/** Every package the project file declares, and none when there is no file. */
export function declaredPackages(context: DoctorContext): readonly DeclaredPackage[] {
  if (!context.exists(PROJECT_DECLARATION)) return [];
  const parsed: unknown = JSON.parse(context.read(PROJECT_DECLARATION));
  if (!isRecord(parsed)) return [];
  const listed: unknown = parsed["packages"];
  if (!isUnknownArray(listed)) return [];
  return listed.flatMap((entry) => packageFromDeclaration(entry));
}

function packageFromDeclaration(entry: unknown): readonly DeclaredPackage[] {
  if (!isRecord(entry)) return [];
  const name: unknown = entry["name"];
  const root: unknown = entry["root"];
  if (!isString(name) || !isString(root)) return [];
  const kind: unknown = entry["kind"];
  return [{ name, root, kind: isString(kind) ? kind : undefined }];
}

/** A repository-relative path inside a declared package's root. */
export function pathInPackage(declared: DeclaredPackage, name: string): string {
  return declared.root.length === 0 ? name : `${declared.root}/${name}`;
}
