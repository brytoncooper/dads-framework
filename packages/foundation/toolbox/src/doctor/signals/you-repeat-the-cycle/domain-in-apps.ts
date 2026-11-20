/**
 * Business logic living in `apps/` beside a database client: report, then
 * ceiling 0. A heuristic.
 *
 * An application is a composition root: it wires packages together, it does
 * not decide anything. A module under `apps/` that opens persistence and then
 * runs a body of work has taken a decision nobody can reuse, nobody can test
 * without the application, and nobody can move without moving the deployment.
 * The first mutation put there is always small, and it is always the one every
 * later mutation is put beside.
 *
 * The reading is a module under an `apps/` package that imports a persistence
 * or database vendor and declares a function of at least five statements. Both
 * halves are needed: an application that only wires is not a finding, and a
 * long function with no persistence is `functions-over-ceiling`'s business.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  addFinding,
  functionBodyOf,
  isProductionModule,
  moduleImports,
  packageOfSpecifier,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const APPLICATION_ROOT = "apps/";
const BUSINESS_STATEMENTS = 5;
const PERSISTENCE = new Set([
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "mongodb",
  "mongoose",
  "redis",
  "ioredis",
  "drizzle-orm",
  "prisma",
  "@prisma/client",
  "typeorm",
  "sequelize",
  "knex",
  "kysely",
  "better-sqlite3",
]);

function persistenceImport(module: DoctorModule): string | undefined {
  for (const imported of moduleImports(module)) {
    const owner = packageOfSpecifier(imported.specifier);
    if (PERSISTENCE.has(owner)) return owner;
  }
  return undefined;
}

/** The longest body in the module, in statements. */
function longestBody(module: DoctorModule): number {
  let longest = 0;
  visitNodes(module.source, (node) => {
    const body = functionBodyOf(node);
    if (body === undefined) return;
    longest = Math.max(longest, body.statements.length);
  });
  return longest;
}

function countDomainInApps(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!module.path.startsWith(APPLICATION_ROOT)) continue;
    if (!isProductionModule(module.path)) continue;
    const vendor = persistenceImport(module);
    if (vendor === undefined) continue;
    if (longestBody(module) < BUSINESS_STATEMENTS) continue;
    addFinding(readings, module.packageRoot, {
      path: module.path,
      name: `logic beside ${vendor}`,
    });
  }
  return readings;
}

export const domainInAppsSignal: DoctorSignal = {
  id: "domain-in-apps",
  issue: "you-repeat-the-cycle",
  question:
    "Does a file under `apps/` import persistence or a vendor client and carry business logic? (heuristic)",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "He put the first mutation in `apps/api`. Your inner child is still defending him.",
  run: (context) => Promise.resolve(countDomainInApps(context)),
};
