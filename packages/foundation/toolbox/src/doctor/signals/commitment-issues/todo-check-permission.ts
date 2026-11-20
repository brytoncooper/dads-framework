/**
 * Deferred access decisions beside a route: ceiling 0.
 *
 * A comment that puts off a decision about who may do something, written
 * within twenty lines of the route that will ship without it, is the one
 * breadcrumb in the whole essay that names its own failure out loud. The
 * relationship was never written down and somebody said so in the file, and
 * then the file shipped anyway.
 *
 * Two things have to be true of a reading, and both are cheap. The words come
 * from a comment rather than from raw text, so a string containing them is a
 * quotation rather than a promise; and the words themselves live in
 * `text-permission-marks.ts` rather than here, because this module writes the
 * lines that recognise a route and a module holding both halves would answer
 * the question about itself.
 *
 * Twenty lines is the companion's number. It is a proximity rule, not a
 * parser: what it buys is that a deferred decision in a module with no routes
 * in it is somebody's note, and the same note beside a handler is a hole.
 *
 * A key is emitted for every module that declares a route, zeros included, so
 * a handler that gains a note reports as being over rather than as a key
 * nothing measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { scanComments } from "../scanners/text-comment-scan.js";
import {
  DEFERRED_WORK_MARK,
  PERMISSION_WORD,
} from "../scanners/text-permission-marks.js";

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mjs", ".cjs", ".js"];
const NEARBY_LINES = 20;

/** The lines that declare or register an HTTP route. */
const ROUTE_MARKS: readonly RegExp[] = [
  /\bmethod\s*:\s*["'`](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i,
  /\bpath\s*:\s*["'`]\//,
  /\.(?:get|post|put|patch|del|delete|all|route)\s*\(\s*["'`]\//i,
  /\b(?:defineRoute|createRoute|registerRoute|addRoute|routeBlueprint)\b/,
];

function routeLines(text: string): readonly number[] {
  const found: number[] = [];
  text.split("\n").forEach((line, offset) => {
    if (ROUTE_MARKS.some((mark) => mark.test(line))) found.push(offset + 1);
  });
  return found;
}

function isNearARoute(line: number, routes: readonly number[]): boolean {
  return routes.some((route) => Math.abs(route - line) <= NEARBY_LINES);
}

function deferredNear(
  text: string,
  routes: readonly number[],
): readonly number[] {
  return scanComments(text)
    .filter(
      (comment) =>
        DEFERRED_WORK_MARK.test(comment.text) &&
        PERMISSION_WORD.test(comment.text) &&
        isNearARoute(comment.line, routes),
    )
    .map((comment) => comment.line);
}

function countDeferredAccessDecisions(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!SCANNED_EXTENSIONS.some((suffix) => path.endsWith(suffix))) continue;
    const text = context.read(path);
    const routes = routeLines(text);
    if (routes.length === 0) continue;
    const found = deferredNear(text, routes);
    readings.set(path, {
      value: found.length,
      evidence: found.map((line) => ({ path, line })),
    });
  }
  return readings;
}

export const todoCheckPermissionSignal: DoctorSignal = {
  id: "todo-check-permission",
  issue: "commitment-issues",
  question:
    "Is there a TODO or FIXME mentioning permission or auth within twenty lines of a route?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "You left a breadcrumb instead: `TODO: check permission` on a route that’s been in prod since March.",
  run: (context) => Promise.resolve(countDeferredAccessDecisions(context)),
};
