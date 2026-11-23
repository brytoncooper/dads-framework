/**
 * One fault, as a line somebody reads on a phone.
 *
 * Formatting lives here rather than in the email because it is a decision with
 * a right answer worth testing — what a reader needs first, and what is
 * noise — and because a template that branches on counts and nulls is a
 * template nobody can review at a glance.
 *
 * Order is deliberate: the type and origin say whether this is your problem,
 * the count says how bad, the location says where to look, and the
 * fingerprint is the handle for looking properly. Someone who stops reading
 * after the first two words has still learned the most important thing.
 */

import type { AlertableFault } from "./summarize-new-faults.js";

export function describeFaultLine(fault: AlertableFault): string {
  const occurrences = fault.occurrences === 1 ? "1 occurrence" : `${fault.occurrences} occurrences`;
  const location = fault.where === null ? "" : ` at ${fault.where}`;
  return `${fault.type} (${fault.origin}) — ${occurrences}${location} · ${fault.fingerprint}`;
}
