/**
 * The signals that read declared routes and the operations behind them.
 *
 * This file belongs to the packages-and-routes lane, so that lane appends here
 * rather than into the registry another lane is holding open. Every signal
 * listed reads the route model, which is built from the blueprints the http
 * toolbox's own inspector parses; where a workspace declares none, they all say
 * they were not measured rather than reporting a clean zero.
 *
 * `latchkey-routes` is not a signal. The companion asks the same question twice
 * — once as avoidant attachment's missing contract, once as the cycle repeating
 * — and `routes-without-access` answers it once and is reported under both.
 *
 * The order is the order the report prints: the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { responsesOutsideEnvelopeSignal } from "../avoidant-attachment/responses-outside-envelope.js";
import { routesWithoutAccessSignal } from "../avoidant-attachment/routes-without-access.js";
import { routesWithoutSchemaSignal } from "../avoidant-attachment/routes-without-schema.js";
import { denialTestsZeroSignal } from "../commitment-issues/denial-tests-zero.js";
import { mutationsWithoutOwnershipSignal } from "../commitment-issues/mutations-without-ownership.js";
import { listsWithoutFilterSignal } from "../failure-to-launch/lists-without-filter.js";
import { logicInControllersSignal } from "../failure-to-launch/logic-in-controllers.js";
import { denialWithBodySignal } from "../people-pleasing/denial-with-body.js";
import { forbidden403Signal } from "../people-pleasing/forbidden-403.js";

/** The nine readings the route model answers. */
export const ROUTE_SIGNALS: readonly DoctorSignal[] = [
  routesWithoutSchemaSignal,
  routesWithoutAccessSignal,
  responsesOutsideEnvelopeSignal,
  forbidden403Signal,
  denialWithBodySignal,
  mutationsWithoutOwnershipSignal,
  denialTestsZeroSignal,
  logicInControllersSignal,
  listsWithoutFilterSignal,
];
