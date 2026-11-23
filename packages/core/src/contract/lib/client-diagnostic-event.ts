/**
 * What a client reports when something went wrong in it (ADR-0117 follow-on).
 *
 * `request_log` records every request the API answered. It cannot record the
 * failures that never became a request: a React render that threw, a rejected
 * promise, a chunk that would not load, a response that did not match the
 * contract the client compiled against. Those are invisible to the server by
 * construction, and this is the envelope that makes them visible.
 *
 * Shaped like `client-context.ts` next door, and for the same reasons: one
 * strict object, every field bounded, and a decoder that NEVER throws. A
 * client reporting a fault is already having a bad time; a report that fails
 * to parse must lose the report, never break the page or the request that
 * carried it.
 *
 * **On personal data.** `message` is the exception's own text and a page's
 * exception text can quote whatever the user typed. It is kept because a
 * fault without its message is rarely actionable, and it is bounded the same
 * way `request_log`'s address and user agent are: by length here, and by a
 * retention sweep in the database. Nothing else in this envelope is free
 * text — frames are code locations, the fingerprint is a hash, and drift
 * issues are paths and codes.
 */

import { z } from "zod";

import { clientContextSchema } from "./client-context.js";

/** The header a client reports through; the route is same-origin with the API. */
export const CLIENT_DIAGNOSTICS_PATH = "/client-diagnostics";

/** One report may carry a small batch, so a burst is one request, not thirty. */
export const CLIENT_DIAGNOSTIC_MAX_EVENTS = 20;

const MAX_MESSAGE = 1_000;
const MAX_NAME = 200;
const MAX_FRAMES = 50;
const MAX_BREADCRUMBS = 30;

/**
 * Where a client was when it failed.
 *
 * `render` is a React tree that threw; `unhandled-rejection` and
 * `window-error` are the two global hooks; `query` and `mutation` are data
 * layer failures; `route` is a navigation that could not complete;
 * `contract-drift` is a response that did not match the compiled contract;
 * `chunk-load` is a code split that would not load and that the version check
 * could NOT explain as an ordinary post-deploy staleness.
 */
export const clientDiagnosticKinds = [
  "render",
  "unhandled-rejection",
  "window-error",
  "query",
  "mutation",
  "route",
  "contract-drift",
  "chunk-load",
] as const;

/** One frame of a stack, as locations rather than as a blob of text. */
export const clientDiagnosticFrameSchema = z.strictObject({
  function: z.string().max(MAX_NAME).optional(),
  file: z.string().max(500).optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
});

/**
 * Something that happened shortly before the fault.
 *
 * Deliberately narrow: a category, a bounded label, and when. A breadcrumb
 * that could carry arbitrary payloads would become the least governed
 * personal-data channel in the system by accident.
 */
export const clientDiagnosticBreadcrumbSchema = z.strictObject({
  at: z.iso.datetime(),
  category: z.enum(["navigation", "request", "interaction", "console"]),
  label: z.string().max(MAX_NAME),
});

export const clientDiagnosticEventSchema = z.strictObject({
  version: z.literal(1),
  occurredAt: z.iso.datetime(),
  /**
   * The client's stable grouping key for this fault — a hash of the exception
   * name and its top in-repo frames. Computed on the client so the same fault
   * groups identically however it arrived, and so grouping never depends on a
   * message whose wording is free to change.
   */
  fingerprint: z.string().min(1).max(128),
  kind: z.enum(clientDiagnosticKinds),
  severity: z.enum(["error", "warning", "info"]),
  /** The exception's class — `TypeError`, `ZodError`, `ApiError`. */
  name: z.string().max(MAX_NAME),
  message: z.string().max(MAX_MESSAGE),
  frames: z.array(clientDiagnosticFrameSchema).max(MAX_FRAMES),
  breadcrumbs: z.array(clientDiagnosticBreadcrumbSchema).max(MAX_BREADCRUMBS),
  /** The build that failed — the same git SHA `version.json` serves. */
  release: z.string().min(1).max(128),
  /**
   * The id of the API call this fault is about, when there was one. This is
   * the join to `request_log` and `audit_log`: one string a user can read off
   * a screenshot reaches the browser's fault, the request's environment, and
   * the rows it changed.
   */
  requestId: z.string().max(128).optional(),
  /** The same environment snapshot the `x-client-context` header carries. */
  context: clientContextSchema.optional(),
});

export type ClientDiagnosticEvent = z.infer<typeof clientDiagnosticEventSchema>;
export type ClientDiagnosticFrame = z.infer<typeof clientDiagnosticFrameSchema>;
export type ClientDiagnosticBreadcrumb = z.infer<
  typeof clientDiagnosticBreadcrumbSchema
>;

/** The request body: a small batch, so a burst costs one round trip. */
export const reportClientDiagnosticsBodySchema = z.strictObject({
  events: z
    .array(clientDiagnosticEventSchema)
    .min(1)
    .max(CLIENT_DIAGNOSTIC_MAX_EVENTS)
    .meta({
      description:
        "The faults this client hit, at least one and at most twenty. A batch so that a page failing several ways at once reports in one request rather than twenty.",
    }),
});

export type ReportClientDiagnosticsBody = z.infer<
  typeof reportClientDiagnosticsBodySchema
>;

/**
 * What the API answers: how many of the batch it stored.
 *
 * A count rather than ids. The client has nothing to do with a stored row, and
 * handing back identifiers would invite a caller to treat a diagnostic report
 * as a resource it owns.
 */
export const reportedClientDiagnosticsSchema = z.strictObject({
  accepted: z.number().int().nonnegative().meta({
    description:
      "How many of the reported faults were stored. Fewer than sent means the rest were duplicates or could not be written; a client has nothing to do about either and should not retry.",
  }),
});

export type ReportedClientDiagnostics = z.infer<
  typeof reportedClientDiagnosticsSchema
>;
