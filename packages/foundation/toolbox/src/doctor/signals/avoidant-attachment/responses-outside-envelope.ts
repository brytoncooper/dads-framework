/**
 * A handler that writes the response itself: ceiling 0.
 *
 * The envelope is the shape every consumer can rely on, and in a workspace with
 * blueprints the framework puts it there: the handler returns the payload and
 * the envelope is applied to it. An object literal coming out of a handler is
 * therefore not an escape — it is the payload doing its job.
 *
 * Two things are escapes. Reaching the transport's own response object and
 * writing to it — `reply.send`, `res.json`, `new Response` — takes the reply
 * out of the envelope's hands entirely. And returning a bare array hands the
 * consumer the raw list the essay names, with no room for the page's meta and
 * no room for a second field later.
 *
 * The reading is per operation, over the handler's own text, so a helper the
 * handler calls is not read here: the question is what the route does with its
 * reply, not what the application does with its data.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { operationEvidence, operationKey, readRouteModel, type RouteOperation } from "../scanners/route-model.js";

/** Writing to the transport's reply, in the shapes the common frameworks use. */
const TRANSPORT_WRITES = [
  /\breply\s*\.\s*(?:send|code|status|type|header)\s*\(/,
  /\bres\s*\.\s*(?:send|json|end|write|status|sendStatus)\s*\(/,
  /\bresponse\s*\.\s*(?:send|json|end|write|status)\s*\(/,
  /\bnew\s+Response\s*\(/,
  /\bResponse\s*\.\s*json\s*\(/,
  /\bctx\s*\.\s*body\s*=/,
];

/** A handler handing back the raw list rather than a page. */
const BARE_ARRAY_RETURN = /\breturn\s*\[/;

function escapesFrom(operation: RouteOperation): readonly string[] {
  if (operation.raw === true) return [];
  const text = operation.handlerText;
  const found = TRANSPORT_WRITES.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return BARE_ARRAY_RETURN.test(text) ? [...found, "return []"] : found;
}

function countEnvelopeEscapes(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const operation of readRouteModel(context).operations) {
    const escapes = escapesFrom(operation);
    const where = operationEvidence(operation);
    readings.set(operationKey(operation), {
      value: escapes.length,
      evidence: escapes.map(() => where),
    });
  }
  return readings;
}

export const responsesOutsideEnvelopeSignal: DoctorSignal = {
  id: "responses-outside-envelope",
  issue: "avoidant-attachment",
  question: "Does any handler return a raw array or object rather than the envelope?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "The first consumer asks a question and you have nothing to hand them except a raw array and “docs coming soon.”",
  run: (context) => Promise.resolve(countEnvelopeEscapes(context)),
};
