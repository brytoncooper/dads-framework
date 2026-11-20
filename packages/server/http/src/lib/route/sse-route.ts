import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";
import {
  defineRawRoute,
  type RawOpenApiOperation,
  type RawRouteBlueprint,
  type RawRouteContext,
} from "./define-raw-route.js";

/**
 * `sseRoute` — the kit primitive for a Server-Sent-Events stream, so no route
 * hand-rolls the same framing twice (docs/architecture/http-edge.md). It is a
 * thin, typed shape over {@link defineRawRoute}: it still declares `access` and
 * flows through the same session/permission wall as every route, but it OWNS the
 * SSE mechanics a stream must get right — hijacking the socket, the
 * `text/event-stream` headers, the keep-alive heartbeat, the `:ready` flush, and
 * tearing the subscription down when the client disconnects.
 *
 * Authorization the kit cannot express (e.g. "may this subject view this org?")
 * stays in the handler: it runs BEFORE any stream opens, denies with the normal
 * error envelope, and only calls `ctx.open(...)` once the caller is cleared —
 * so a denial never leaks a hijacked socket.
 */

/** Silent-comment keep-alive cadence — proxies/browsers drop an idle stream otherwise. */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

/** The write surface a stream handler uses; the kit owns the wire framing. */
export type SseStream = {
  /** Emit one `data: <json>\n\n` event frame. */
  send(data: unknown): void;
  /** Emit a bare `:<text>\n\n` comment (readiness marker, manual keep-alive). */
  comment(text?: string): void;
};

/** Runs when the client disconnects — release every subscription here. */
export type SseCleanup = () => void;

export type SseRouteContext = RawRouteContext & {
  /**
   * Open the stream: hijack the socket, write the event-stream headers, wire the
   * heartbeat, flush `:ready`, then keep the connection live. `onOpen` receives
   * the write surface and returns the teardown to run on disconnect. Call this
   * ONLY after the handler has authorized the request; to deny, send an error and
   * return without calling it.
   *
   * A property (not a method) so a handler can safely destructure `{ open }`.
   */
  readonly open: (onOpen: (stream: SseStream) => SseCleanup) => void;
};

export type SseRouteConfig = {
  readonly path: string;
  readonly summary: string;
  readonly access: RouteAccess;
  /** Route-rung of the capability ladder (route, then group, then app). */
  readonly capabilities?: RouteCapabilities;
  /** Keep-alive cadence; defaults to {@link DEFAULT_SSE_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  readonly openapi: RawOpenApiOperation;
  readonly handler: (ctx: SseRouteContext) => Promise<void>;
};

/** Declare an SSE route. `access` is required — the same wall as every verb. */
export function sseRoute(config: SseRouteConfig): RawRouteBlueprint {
  return defineRawRoute({
    method: "GET",
    path: config.path,
    summary: config.summary,
    access: config.access,
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: config.capabilities }),
    openapi: config.openapi,
    handler: async (ctx) => {
      const open = (onOpen: (stream: SseStream) => SseCleanup): void => {
        const { reply, request } = ctx;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": String(
            reply.getHeader("cache-control") ?? "no-cache",
          ),
          connection: "keep-alive",
        });

        const stream: SseStream = {
          send: (data) => {
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          },
          comment: (text = "") => {
            reply.raw.write(`:${text}\n\n`);
          },
        };

        const release = onOpen(stream);
        const heartbeat = setInterval(() => {
          stream.comment();
        }, config.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS);
        heartbeat.unref();
        request.raw.once("close", () => {
          clearInterval(heartbeat);
          release();
        });

        // Flush headers so the client (and tests) know the stream is ready
        // before any delta arrives.
        stream.comment("ready");
      };

      await config.handler({ ...ctx, open });
    },
  });
}
