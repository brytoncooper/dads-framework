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
  /** Whether the stream has been closed by the server or client disconnect. */
  readonly closed: boolean;
  /** Emit one `data: <json>\n\n` event frame. No-op once the stream is closed. */
  send(data: unknown): void;
  /** Emit a bare `:<text>\n\n` comment (readiness marker, manual keep-alive). No-op once closed. */
  comment(text?: string): void;
  /** Idempotently close the stream, clear its heartbeat, run teardown once, and end the HTTP response. */
  close(): void;
};

/** Runs when the client disconnects or the server closes the stream — release every subscription here. */
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

function openSseStream(ctx: RawRouteContext, heartbeatMs: number, onOpen: (stream: SseStream) => SseCleanup): void {
  const { reply, request } = ctx;
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": String(reply.getHeader("cache-control") ?? "no-cache"),
    connection: "keep-alive",
  });

  const state = { closed: false };
  let release: SseCleanup | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const teardown = (): void => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    request.raw.off("close", teardown);
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    const cleanup = release;
    release = undefined;
    cleanup?.();
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      reply.raw.end();
    }
  };

  const stream: SseStream = {
    get closed() {
      return state.closed;
    },
    send: (data) => {
      if (state.closed || reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment: (text = "") => {
      if (state.closed || reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      reply.raw.write(`:${text}\n\n`);
    },
    close: teardown,
  };

  const onOpenRelease = onOpen(stream);
  if (state.closed) {
    onOpenRelease();
    return;
  }
  release = onOpenRelease;
  heartbeat = setInterval(() => {
    stream.comment();
  }, heartbeatMs);
  heartbeat.unref();
  request.raw.once("close", teardown);

  // Flush headers so the client (and tests) know the stream is ready
  // before any delta arrives.
  stream.comment("ready");
}

/** Declare an SSE route. `access` is required — the same wall as every verb. */
export function sseRoute(config: SseRouteConfig): RawRouteBlueprint {
  const heartbeatMs = config.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  return defineRawRoute({
    method: "GET",
    path: config.path,
    summary: config.summary,
    access: config.access,
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
    openapi: config.openapi,
    handler: async (ctx) => {
      const open = (onOpen: (stream: SseStream) => SseCleanup): void => {
        openSseStream(ctx, heartbeatMs, onOpen);
      };

      await config.handler({ ...ctx, open });
    },
  });
}
