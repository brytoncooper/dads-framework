/**
 * Two packages opening the same database client: ceiling 0.
 *
 * One package may own a client. The failure is the second one, because from
 * that moment the schema is a contract nobody wrote down and every migration is
 * a conversation two packages have to have with no interface between them. Both
 * are named: the key is the package and the number is how many of its clients
 * another package also opens, so a workspace where every client has one owner
 * reads zero everywhere.
 *
 * The composition root is not one of them. Choosing the provider once, where
 * the application is assembled, and handing it to the package that owns the
 * capability is the cure rather than the disease; a provider constructed
 * somewhere else is `provider-chosen-outside-root`. Excluding it needs a kind,
 * so a workspace with no declaration reports that it was not measured.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import {
  readPackageGraph,
  vendorImports,
  type PackageImport,
} from "../scanners/package-graph.js";

/** The clients a package opens a database with. */
const DATABASE_CLIENTS = new Set([
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "mongodb",
  "mongoose",
  "better-sqlite3",
  "sqlite3",
  "oracledb",
  "mssql",
  "cassandra-driver",
  "@neondatabase/serverless",
  "@planetscale/database",
]);

/** Every package that opens a database client, and the clients it opens. */
function clientsByPackage(
  context: DoctorContext,
): ReadonlyMap<string, readonly PackageImport[]> {
  const graph = readPackageGraph(context);
  const opened = new Map<string, readonly PackageImport[]>();
  if (!graph.declared) return opened;
  for (const declared of graph.packages) {
    if (declared.kind === "composition") continue;
    opened.set(
      declared.name,
      vendorImports(graph, declared).filter((entry) =>
        DATABASE_CLIENTS.has(entry.module ?? ""),
      ),
    );
  }
  return opened;
}

/** How many packages open each client, so a second owner is one lookup away. */
function ownersByClient(
  opened: ReadonlyMap<string, readonly PackageImport[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [name, entries] of opened) {
    for (const entry of entries) {
      const client = entry.module ?? "";
      const holding = owners.get(client) ?? new Set<string>();
      holding.add(name);
      owners.set(client, holding);
    }
  }
  return owners;
}

function countSharedClients(context: DoctorContext) {
  const opened = clientsByPackage(context);
  const owners = ownersByClient(opened);
  const readings = new Map<string, SignalReading>();
  for (const [name, entries] of opened) {
    const shared = entries.filter(
      (entry) => (owners.get(entry.module ?? "")?.size ?? 0) > 1,
    );
    readings.set(name, {
      value: new Set(shared.map((entry) => entry.module)).size,
      evidence: shared.map((entry) => ({
        path: entry.path,
        line: entry.line,
        name: entry.specifier,
      })),
    });
  }
  return readings;
}

export const sharedDatabaseSignal: DoctorSignal = {
  id: "shared-database",
  issue: "you-stay-with-people-who-cannot-meet-you",
  question: "Does more than one package open the same database client?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "You got your own place (microservice) and you still do laundry at mom’s (the shared database).",
  run: (context) => Promise.resolve(countSharedClients(context)),
};
