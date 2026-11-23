/**
 * A framework or an ORM inside a `core` package: ceiling 0.
 *
 * `core` is the layer that names the capability. The moment a framework or an
 * ORM is imported there, the vocabulary belongs to the vendor: the entity is
 * whatever the ORM calls a row, the handler shape is whatever the framework
 * accepts, and the domain has taken the vendor's last name. The eleven names
 * here are the ones `docs/daddy-issues.md` lists, matched as the package a
 * specifier names and as its scope, so `@nestjs/common` counts as nest and
 * `@prisma/client` as prisma.
 *
 * Every `core` package gets a key and the number is how many of the eleven it
 * imports, zero included, so a domain that owns its own words reads as owning
 * them. This needs a kind, so it needs a declaration. A workspace with no
 * `dads.project.json` has no `core` packages — it has packages nobody has said
 * anything about — and the signal reports that it was not measured rather than
 * deciding for itself which package is the domain.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { readPackageGraph, vendorImports, type PackageImport } from "../scanners/package-graph.js";

import { readSourceBindings } from "../scanners/source-bindings.js";

/** The frameworks and ORMs the companion names, with the scopes they publish under. */
const FRAMEWORKS = new Map<string, string>([
  ["nest", "nest"],
  ["@nestjs", "nest"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["@fastify", "fastify"],
  ["koa", "koa"],
  ["@hapi", "hapi"],
  ["hapi", "hapi"],
  ["prisma", "prisma"],
  ["@prisma", "prisma"],
  ["drizzle-orm", "drizzle"],
  ["typeorm", "typeorm"],
  ["sequelize", "sequelize"],
  ["mongoose", "mongoose"],
  ["knex", "knex"],
]);

/** The framework a specifier belongs to, by package name or by scope. */
export function frameworkNamed(module: string): string | undefined {
  const scope = module.startsWith("@") ? module.split("/")[0] : undefined;
  return FRAMEWORKS.get(module) ?? (scope ? FRAMEWORKS.get(scope) : undefined);
}

function frameworkImports(imports: readonly PackageImport[]): ReadonlyMap<string, readonly PackageImport[]> {
  const found = new Map<string, PackageImport[]>();
  for (const entry of imports) {
    const framework = frameworkNamed(entry.module ?? "");
    if (framework === undefined) continue;
    const seen = found.get(framework) ?? [];
    seen.push(entry);
    found.set(framework, seen);
  }
  return found;
}

function permitsDomainServerPersistence(
  declared: { readonly root: string; readonly allowedDependencies: readonly string[] },
  entry: PackageImport,
): boolean {
  if (entry.module !== "drizzle-orm") return false;
  if (!declared.allowedDependencies.includes("drizzle-orm")) return false;
  const serverPrefix = `${declared.root}/server/`;
  return (
    (declared.root.startsWith("domains/") || declared.root.startsWith("src/domains/")) &&
    entry.path.startsWith(serverPrefix)
  );
}

function countFrameworksInCore(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  if (!graph.declared) return readings;
  for (const declared of graph.packages) {
    if (declared.kind !== "core") continue;
    const bindings = readSourceBindings(context, declared);
    const found = frameworkImports(
      vendorImports(graph, declared).filter(
        (entry) =>
          !permitsDomainServerPersistence(declared, entry) &&
          !bindings.some(
            (binding) =>
              entry.module !== undefined &&
              entry.path.startsWith(`${binding.sourceRoot}/`) &&
              binding.dependencies.includes(entry.module),
          ),
      ),
    );
    const entries = [...found.values()].flat();
    readings.set(declared.name, {
      value: found.size,
      evidence: entries.map((entry) => ({
        path: entry.path,
        line: entry.line,
        name: entry.specifier,
      })),
    });
  }
  return readings;
}

export const frameworkInCoreSignal: DoctorSignal = {
  id: "framework-in-core",
  issue: "you-are-looking-for-a-father-figure",
  question: "Does a `core` package import a framework or ORM?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You keep bringing home ORMs that want to name the children.",
  run: (context) => Promise.resolve(countFrameworksInCore(context)),
};
