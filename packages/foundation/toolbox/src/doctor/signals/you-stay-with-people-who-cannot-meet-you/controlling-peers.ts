/**
 * A peer dependency that pins the runtime: ceiling 0.
 *
 * A peer dependency on a library is a contract: you and I must agree on one
 * copy of this. A peer dependency on `node`, on a package manager, or on the
 * Node type definitions is not that contract. It is a package deciding which
 * runtime a consumer is allowed to see, and every consumer inherits the
 * decision without ever agreeing to it. The engines field says the same thing
 * about this package; a peer says it about everyone downstream.
 *
 * Every manifest gets a key, zero included, so a repository that has never
 * written one reads as holding the line rather than as not measured.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { readPackageGraph } from "../scanners/package-graph.js";

function countRuntimePeers(context: DoctorContext) {
  const graph = readPackageGraph(context);
  const readings = new Map<string, SignalReading>();
  for (const manifest of graph.manifests) {
    readings.set(manifest.name ?? manifest.path, {
      value: manifest.runtimePeers.length,
      evidence: manifest.runtimePeers.map((peer) => ({
        path: manifest.path,
        name: peer,
      })),
    });
  }
  return readings;
}

export const controllingPeersSignal: DoctorSignal = {
  id: "controlling-peers",
  issue: "you-stay-with-people-who-cannot-meet-you",
  question: "Does any peer dependency pin engines or a Node version?",
  reads: "packages",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "It controls who you import, what you return, and which Node version you’re allowed to see.",
  run: (context) => Promise.resolve(countRuntimePeers(context)),
};
