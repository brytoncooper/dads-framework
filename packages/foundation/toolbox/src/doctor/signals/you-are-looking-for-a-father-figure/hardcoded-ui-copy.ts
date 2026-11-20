/**
 * Words written into a renderer that has a catalog: ceiling 0.
 *
 * A package that depends on the copy kit has said where its words live: in a
 * catalog, under a typed key, where they can be reviewed, translated, and
 * changed in one place. A string literal at a seam a customer reads — JSX
 * text, a `label` or `aria-label`, a toast, a copy-shaped property, a returned
 * fallback — is a word that skipped the catalog, and the screen now speaks two
 * languages: the one the package owns and the one somebody typed.
 *
 * Only packages that adopted the catalog are asked. One without it never made
 * the promise, and a rule it never agreed to is noise. Copy keys, lowercase
 * data tokens, codes in capitals, URLs and paths are not words, and are not
 * counted. Every renderer in such a package is a key, zeros included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  isHardcodedCopy,
  renderedCopySpans,
} from "../scanners/rendered-copy.js";
import { evidenceAt } from "../scanners/typescript-program.js";
import { readRendererScope } from "../scanners/web-renderers.js";

function countHardcodedCopy(context: DoctorContext): SignalReadings {
  const scope = readRendererScope(context);
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!scope.usesCatalog(module)) continue;
    const evidence = renderedCopySpans(module.source)
      .filter((span) => isHardcodedCopy(span.text))
      .map((span) => evidenceAt(module, span.node, span.seam));
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

export const hardcodedUiCopySignal: DoctorSignal = {
  id: "hardcoded-ui-copy",
  issue: "you-are-looking-for-a-father-figure",
  question:
    "Does a renderer in a package that uses a copy catalog write customer-visible words inline?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "If you do not own the language, you will speak whoever is loudest.",
  run: (context) => Promise.resolve(countHardcodedCopy(context)),
};
