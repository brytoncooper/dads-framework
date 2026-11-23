/**
 * A captured fault, as the one Sentry envelope it is sent in.
 *
 * Pure: the event id and the time come in, a string goes out. Everything that
 * decides what leaves the building lives here, so the scrubbing rules are
 * proved in one place:
 *
 * - **What is sent:** the exception's type, its message (with anything shaped
 *   like an email address replaced), its stack frames, the severity, the
 *   environment and release, the matched route pattern, the request id, the
 *   job name, the instance, and the user's id.
 * - **What is never sent:** a request body, a header, a cookie, a query
 *   string, a url, a user's name or email. `FaultEvent` does not carry the
 *   first five at all; a route pattern has any query cut off in case one was
 *   ever passed where a pattern belongs.
 * - **Grouping is ours.** `fingerprint` is the fault's own fingerprint, so
 *   Sentry's issues split and merge exactly where `request_log` already does.
 */

import { severityOf, type FaultEvent } from "../diagnostics-reporter.js";
import { describeException } from "./describe-exception.js";

/** Where an envelope goes: the parts of a DSN, already checked. */
export type SentryDestination = {
  readonly publicKey: string;
  /** Host, with its port when it is not the default. */
  readonly host: string;
  readonly projectId: string;
};

export type SentryEnvelopeContext = {
  /** 32 lowercase hex characters. */
  readonly eventId: string;
  readonly now: Date;
  readonly environment?: string;
  readonly release?: string;
};

export type SentryFrame = {
  readonly function?: string;
  readonly filename: string;
  readonly lineno: number;
  readonly colno: number;
  readonly in_app: boolean;
};

/** Deeper frames are cut: the top of the stack is where a fault is read. */
const MAX_FRAMES = 50;
const SENTRY_CLIENT = "dads-diagnostics/1.0";

export function sentryEnvelopeUrl(destination: SentryDestination): string {
  return `https://${destination.host}/api/${destination.projectId}/envelope/`;
}

export function sentryAuthHeader(destination: SentryDestination): string {
  return `Sentry sentry_version=7, sentry_key=${destination.publicKey}, sentry_client=${SENTRY_CLIENT}`;
}

export function buildSentryEnvelope(event: FaultEvent, context: SentryEnvelopeContext): string {
  const payload = buildSentryEvent(event, context);
  return [
    JSON.stringify({
      event_id: context.eventId,
      sent_at: context.now.toISOString(),
    }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(payload),
  ].join("\n");
}

export function buildSentryEvent(event: FaultEvent, context: SentryEnvelopeContext): Record<string, unknown> {
  const described = describeException(event.error);
  const severity = severityOf(event);
  const release = event.release ?? context.release;
  const frames = parseStackFrames(described.stack);

  return {
    event_id: context.eventId,
    timestamp: context.now.getTime() / 1_000,
    platform: "node",
    logger: "dads-diagnostics",
    level: severity,
    ...(context.environment === undefined ? {} : { environment: context.environment }),
    ...(release === undefined ? {} : { release }),
    ...(event.instanceId === undefined ? {} : { server_name: event.instanceId }),
    exception: {
      values: [
        {
          type: described.type,
          value: withoutEmails(described.message),
          mechanism: { type: "generic", handled: severity !== "fatal" },
          ...(frames.length === 0 ? {} : { stacktrace: { frames } }),
        },
      ],
    },
    tags: tagsOf(event),
    fingerprint: [event.fingerprint ?? described.fingerprint],
    ...(event.actor === undefined ? {} : { user: { id: event.actor.id } }),
  };
}

function tagsOf(event: FaultEvent): Record<string, string> {
  return {
    source: event.source,
    ...(event.routeId === undefined ? {} : { route: withoutQuery(event.routeId) }),
    ...(event.requestId === undefined ? {} : { request_id: event.requestId }),
    ...(event.jobName === undefined ? {} : { job_name: event.jobName }),
    ...(event.actor === undefined ? {} : { actor_kind: event.actor.kind }),
  };
}

/**
 * V8 stack lines as Sentry frames, oldest call first as Sentry expects.
 *
 * `in_app` follows the fingerprint's rule: a frame is the application's
 * unless it is `node_modules` or a Node internal (`describe-exception.ts`).
 */
export function parseStackFrames(stack: string | undefined): SentryFrame[] {
  if (stack === undefined) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = parseFrame(line.trim());
    if (frame !== undefined) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

const FRAME_WITH_FUNCTION = /^at (?:async )?(.+?) \((.+):(\d+):(\d+)\)$/;
const FRAME_WITHOUT_FUNCTION = /^at (?:async )?(.+):(\d+):(\d+)$/;

function parseFrame(line: string): SentryFrame | undefined {
  const named = FRAME_WITH_FUNCTION.exec(line);
  if (named !== null) {
    const [, name, filename, lineno, colno] = named;
    if (filename === undefined) return undefined;
    return {
      ...(name === undefined ? {} : { function: name }),
      ...location(filename, lineno, colno),
    };
  }
  const bare = FRAME_WITHOUT_FUNCTION.exec(line);
  if (bare === null) return undefined;
  const [, filename, lineno, colno] = bare;
  if (filename === undefined) return undefined;
  return location(filename, lineno, colno);
}

function location(
  filename: string,
  lineno: string | undefined,
  colno: string | undefined,
): Omit<SentryFrame, "function"> {
  return {
    filename,
    lineno: Number(lineno),
    colno: Number(colno),
    in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
  };
}

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;

/** A message can quote what a user typed; an address is the likeliest thing. */
function withoutEmails(message: string): string {
  return message.replace(EMAIL, "[email]");
}

function withoutQuery(route: string): string {
  const at = route.indexOf("?");
  return at === -1 ? route : route.slice(0, at);
}
