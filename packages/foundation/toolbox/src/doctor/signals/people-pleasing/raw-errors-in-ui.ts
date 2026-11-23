/**
 * Raw failure messages shown to a customer: ceiling 0.
 *
 * A failure's message is written for whoever debugs it. Put it on a screen and
 * the person who did nothing wrong reads a constraint name, a stack frame, or a
 * vendor's sentence about a socket, and learns nothing they can act on except
 * that the product was not expecting them. The renderer's job is to branch on
 * the failure's stable data — its code, its status — and say something it
 * wrote itself.
 *
 * The renderers asked are production modules that put words on a screen: a
 * `.tsx` module, or any module in a package that depends on React, minus
 * catalogs, tests and fixtures. The transport, the server and the logs keep the
 * raw message, because that is where it belongs. Every renderer is a key,
 * zeros included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { rawFailureSpans } from "../scanners/raw-failures.js";
import { evidenceAt } from "../scanners/typescript-program.js";
import { readRendererScope } from "../scanners/web-renderers.js";

function countRawFailures(context: DoctorContext): SignalReadings {
  const scope = readRendererScope(context);
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!scope.isRenderer(module)) continue;
    const evidence = rawFailureSpans(module.source).map((span) => evidenceAt(module, span.node, span.seam));
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

export const rawErrorsInUiSignal: DoctorSignal = {
  id: "raw-errors-in-ui",
  issue: "people-pleasing",
  question: "Does a renderer show a failure's raw message instead of copy it chose for the failure's code?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You can’t sit with 404. You have to explain. That’s not kindness. That’s fear.",
  run: (context) => Promise.resolve(countRawFailures(context)),
};
