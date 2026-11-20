/**
 * Which modules put words on a screen somebody reads.
 *
 * A renderer is production TypeScript that either is a `.tsx` module or sits
 * in a package whose manifest depends on React. Tests, fixtures, testing
 * helpers, generated modules and copy catalogs are not renderers: a catalog is
 * where the words are supposed to live, and the rest never reach a customer.
 *
 * A renderer uses a copy catalog when its package depends on the copy kit.
 * That is the line `hardcoded-ui-copy` holds: a package that has adopted a
 * catalog and still writes its words inline. A package with no catalog has not
 * made that promise, and holding it to one would be a rule it never agreed to.
 */

import type { DoctorContext } from "../../doctor-context.js";
import {
  manifestRootOf,
  readPackageGraph,
  type PackageManifestFacts,
} from "./package-graph.js";
import { isProductionModule, type DoctorModule } from "./typescript-program.js";

const REACT = "react";
const COPY_KIT = "@dads-framework/copy";
const RENDERED_EXTENSION = ".tsx";
const NOT_RENDERED = ["/copy/", "/fixtures/", "/__fixtures__/", "/testing/"];
const GENERATED = [".gen.ts", ".gen.tsx"];

export type RendererScope = {
  /** True for a module that renders what a customer reads. */
  isRenderer(module: DoctorModule): boolean;
  /** True for a renderer whose package has adopted the copy kit. */
  usesCatalog(module: DoctorModule): boolean;
};

function dependsOn(
  manifest: PackageManifestFacts | undefined,
  name: string,
): boolean {
  if (manifest === undefined) return false;
  return (
    manifest.dependencies.includes(name) ||
    manifest.peerDependencies.includes(name)
  );
}

function isRenderedPath(path: string): boolean {
  if (!isProductionModule(path)) return false;
  if (NOT_RENDERED.some((segment) => path.includes(segment))) return false;
  return !GENERATED.some((suffix) => path.endsWith(suffix));
}

/** The renderer scope for this run, from the manifests the tree holds. */
export function readRendererScope(context: DoctorContext): RendererScope {
  const manifests = new Map(
    readPackageGraph(context).manifests.map((manifest) => [
      manifestRootOf(manifest),
      manifest,
    ]),
  );
  const isRenderer = (module: DoctorModule): boolean => {
    if (!isRenderedPath(module.path)) return false;
    if (module.path.endsWith(RENDERED_EXTENSION)) return true;
    return dependsOn(manifests.get(module.packageRoot), REACT);
  };
  return {
    isRenderer,
    usesCatalog: (module) =>
      isRenderer(module) &&
      dependsOn(manifests.get(module.packageRoot), COPY_KIT),
  };
}
