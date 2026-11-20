/**
 * A vendor client constructed away from the composition root: ceiling 0.
 *
 * Choosing the provider is the one decision the application makes, and it
 * makes it once, at the front door. A `new Client()` inside a handler is that
 * decision taken again, in a module that cannot be tested without the vendor,
 * cannot be pointed at a stand-in, and now owns configuration it was never
 * given. Everything past the door was supposed to speak the house's language
 * and not know who is cooking.
 *
 * A construction is a vendor construction when the constructor was imported
 * from a package outside the workspace. Three places are exempt, and the
 * companion names all three: a module whose name says it is the composition
 * root; a package the declaration calls an adapter, which is the one place a
 * vendor is allowed to be at home; and an application module that is not a
 * handler, because an application *is* the front door — "inside a handler or a
 * domain module is a yes" is how the companion puts it, and a library is a
 * domain module wherever it sits. A binding can construct a library it
 * explicitly lists in its own allowed dependencies.
 */

import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  evidenceAt,
  importedBindings,
  isLocalSpecifier,
  isProductionModule,
  packageOfSpecifier,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const COMPOSITION_ROOTS = new Set([
  "main.ts",
  "composition-root.ts",
  "container.ts",
  "bootstrap.ts",
]);
const VENDOR_HOMES = new Set(["adapter", "integration"]);
const APPLICATION_ROOT = "apps/";
const HANDLER_PATH = /route|handler|controller/i;

/** True where choosing the provider is the module's job. */
function assembles(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (COMPOSITION_ROOTS.has(name)) return true;
  return path.startsWith(APPLICATION_ROOT) && !HANDLER_PATH.test(path);
}

function constructedName(node: ts.Node): string | undefined {
  if (!ts.isNewExpression(node)) return undefined;
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

function vendorConstructions(
  module: DoctorModule,
  workspace: ReadonlySet<string>,
  owner: DoctorPackage | undefined,
): readonly SignalEvidence[] {
  const bindings = importedBindings(module);
  const found: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    const name = constructedName(node);
    const specifier = name === undefined ? undefined : bindings.get(name);
    if (specifier === undefined || isLocalSpecifier(specifier)) return;
    const dependency = packageOfSpecifier(specifier);
    if (workspace.has(dependency)) return;
    if (
      owner?.kind === "binding" &&
      owner.allowedDependencies.includes(dependency)
    ) {
      return;
    }
    found.push(evidenceAt(module, node, `new ${name ?? ""} from ${specifier}`));
  });
  return found;
}

function countProvidersOutsideRoot(context: DoctorContext): SignalReadings {
  const packages = context.packages();
  const workspace = new Set(packages.map((declared) => declared.name));
  const owners = new Map(packages.map((declared) => [declared.root, declared]));
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (assembles(module.path)) continue;
    const owner = owners.get(module.packageRoot);
    if (VENDOR_HOMES.has(owner?.kind ?? "")) continue;
    const evidence = vendorConstructions(module, workspace, owner);
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

export const providerChosenOutsideRootSignal: DoctorSignal = {
  id: "provider-chosen-outside-root",
  issue: "the-paper-wall",
  question:
    "Is the provider constructed anywhere other than the composition root?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "A boundary is a contract you wrote, in your words, that a provider implements, and that you choose once, at the front door, where the app is assembled.",
  run: (context) => Promise.resolve(countProvidersOutsideRoot(context)),
};
