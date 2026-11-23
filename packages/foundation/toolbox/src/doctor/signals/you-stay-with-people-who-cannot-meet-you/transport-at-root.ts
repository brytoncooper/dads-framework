/**
 * A transport library reached from outside an adapter: ceiling 0.
 *
 * Fastify and Express are the two the companion names, and the failure is not
 * that a package imports one without declaring it — that is a vendor crossing,
 * and `vendor-outside-adapter` owns it. It is that the transport is reachable
 * at all from a package whose job is not binding a transport. A composition
 * root that installs Fastify honestly, declares it, and then imports its types
 * into the domain has still moved the transport in.
 *
 * So the rule is the kind, not the manifest: only an `adapter` may name a
 * transport. Every other package gets a key, zero included. That needs a
 * declaration, and a workspace without one reports that it was not measured
 * rather than deciding which of its packages was supposed to be the adapter.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { readPackageGraph, vendorImports } from "../scanners/package-graph.js";

/** The transport libraries `docs/daddy-issues.md` names, and their scopes. */
const TRANSPORTS = new Map<string, string>([
  ["fastify", "fastify"],
  ["@fastify", "fastify"],
  ["express", "express"],
]);

function transportNamed(module: string): string | undefined {
  const scope = module.startsWith("@") ? module.split("/")[0] : undefined;
  return TRANSPORTS.get(module) ?? (scope ? TRANSPORTS.get(scope) : undefined);
}

function countTransportsOutsideAdapters(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  if (!graph.declared) return readings;
  for (const declared of graph.packages) {
    if (declared.kind === "adapter") continue;
    const reached = vendorImports(graph, declared).filter((entry) => transportNamed(entry.module ?? "") !== undefined);
    readings.set(declared.name, {
      value: reached.length,
      evidence: reached.map((entry) => ({
        path: entry.path,
        line: entry.line,
        name: entry.specifier,
      })),
    });
  }
  return readings;
}

export const transportAtRootSignal: DoctorSignal = {
  id: "transport-at-root",
  issue: "you-stay-with-people-who-cannot-meet-you",
  question: "Is fastify or express imported outside the http-server adapter?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Fastify has a toothbrush at your composition root.",
  run: (context) => Promise.resolve(countTransportsOutsideAdapters(context)),
};
