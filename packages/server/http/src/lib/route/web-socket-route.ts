import type { FastifyInstance } from "fastify";
import { type IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";
import {
  defineRawRoute,
  type RawOpenApiOperation,
  type RawRouteBlueprint,
  type RawRouteContext,
} from "./define-raw-route.js";

/**
 * `webSocketRoute`: the kit primitive for a WebSocket a client opens with a
 * GET upgrade. Like `sseRoute`, it is a raw route: the upgrade request flows
 * through the same access wall, machine-credential resolver, rate limit and
 * request log as every route, and a refusal answers with the normal status
 * and error envelope before any socket opens. Only a handler that has
 * authorized the caller calls `accept`.
 *
 * Node hands an upgrade request to the server's `upgrade` event, not to
 * Fastify. Mounting a WebSocket route installs one `upgrade` listener
 * (`acceptWebSocketUpgrades`) that routes the request through Fastify with a
 * response bound to the raw socket, as `@fastify/websocket` does. An app with
 * no WebSocket route installs nothing, so its upgrade handling is unchanged.
 */

/** The largest message a client may send; a channel's own messages are tiny. */
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Close code for a server going away (deploy, shutdown). */
const GOING_AWAY = 1001;

/** One open socket, as a route handler sees it. Text frames only. */
export type WebSocketConnection = {
  send(text: string): void;
  /** A protocol ping; the peer's pong arrives through `onPong`. */
  ping(): void;
  onPong(listener: () => void): void;
  onMessage(listener: (text: string) => void): void;
  /** Runs once, however the socket ended. */
  onClose(listener: () => void): void;
  close(code: number, reason: string): void;
  /** Drops the socket without a close handshake (a dead peer). */
  terminate(): void;
};

export type WebSocketRouteContext = RawRouteContext & {
  /**
   * Completes the upgrade and calls `onOpen` with the open socket. Call it
   * ONLY after the handler has authorized the request; to refuse, throw or
   * send an error and return without calling it.
   */
  readonly accept: (onOpen: (connection: WebSocketConnection) => void) => void;
};

export type WebSocketRouteConfig = {
  readonly path: string;
  readonly summary: string;
  readonly access: RouteAccess;
  readonly capabilities?: RouteCapabilities;
  readonly openapi: RawOpenApiOperation;
  readonly handler: (ctx: WebSocketRouteContext) => Promise<void>;
};

type PendingUpgrade = {
  readonly socket: Duplex;
  readonly head: Buffer;
  /** The app's sockets, closed when the app closes. */
  readonly app: AppSockets;
  claimed: boolean;
};

/** One app's open sockets, and whether it has begun closing. */
type AppSockets = { readonly open: Set<WebSocket>; closing: boolean };

/** Every path a `webSocketRoute` declared, so the app knows a mounted route is one. */
const webSocketPaths = new Set<string>();

/** Whether a mounted route's URL (its prefix included) is a declared WebSocket route. */
export function isWebSocketRoutePath(url: string): boolean {
  for (const path of webSocketPaths) if (url.endsWith(path)) return true;
  return false;
}

const pendingUpgrades = new WeakMap<IncomingMessage, PendingUpgrade>();
const appsAcceptingUpgrades = new WeakSet<object>();
const upgrades = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  maxPayload: MAX_PAYLOAD_BYTES,
});

/** Declare a WebSocket route. `access` is required, the same wall as every verb. */
export function webSocketRoute(
  config: WebSocketRouteConfig,
): RawRouteBlueprint {
  webSocketPaths.add(config.path);
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
      const pending = pendingUpgrades.get(ctx.request.raw);
      if (pending === undefined) {
        // A plain GET: nothing to upgrade.
        await ctx.reply
          .status(426)
          .header("upgrade", "websocket")
          .send({
            error: {
              code: "UPGRADE_REQUIRED",
              message: "This route answers only a WebSocket upgrade",
            },
          });
        return;
      }
      const accept = (
        onOpen: (connection: WebSocketConnection) => void,
      ): void => {
        pending.claimed = true;
        ctx.reply.hijack();
        upgrades.handleUpgrade(
          ctx.request.raw,
          pending.socket,
          pending.head,
          (socket) => {
            // A bad frame (too large, malformed) is an error on the socket;
            // unheard, it would take the whole process down.
            socket.on("error", (error) => {
              ctx.log.warn({
                event: "websocket.socket_error",
                path: config.path,
                error: error.message,
              });
              socket.terminate();
            });
            if (pending.app.closing) {
              socket.close(GOING_AWAY, "server closing");
              return;
            }
            pending.app.open.add(socket);
            socket.once("close", () => pending.app.open.delete(socket));
            onOpen(connectionOver(socket));
          },
        );
      };
      await config.handler({ ...ctx, accept });
    },
  });
}

/**
 * Routes upgrade requests through Fastify, once per app. A request no
 * WebSocket route claims gets its normal answer (a 404, a 401) written to
 * the socket, which then closes. Every socket still open when the app
 * closes is closed with 1001.
 */
export function acceptWebSocketUpgrades(app: FastifyInstance): void {
  if (appsAcceptingUpgrades.has(app.server)) return;
  appsAcceptingUpgrades.add(app.server);
  const sockets: AppSockets = { open: new Set(), closing: false };

  app.server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pending: PendingUpgrade = {
        socket,
        head,
        app: sockets,
        claimed: false,
      };
      pendingUpgrades.set(request, pending);
      socket.on("error", () => socket.destroy());
      const response = new ServerResponse(request);
      response.assignSocket(asNetSocket(socket));
      response.on("finish", () => {
        if (!pending.claimed) socket.end();
      });
      app.routing(request, response);
    },
  );
  app.addHook("preClose", (done) => {
    // A socket accepted from here on is closed at once, too.
    sockets.closing = true;
    for (const client of sockets.open) {
      client.close(GOING_AWAY, "server closing");
    }
    done();
  });
}

function connectionOver(socket: WebSocket): WebSocketConnection {
  return {
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    ping: () => {
      if (socket.readyState === socket.OPEN) socket.ping();
    },
    onPong: (listener) => {
      socket.on("pong", listener);
    },
    onMessage: (listener) => {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) listener(textOf(data));
      });
    },
    onClose: (listener) => {
      socket.once("close", listener);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
    terminate: () => {
      socket.terminate();
    },
  };
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Node's `upgrade` event hands the connection's socket as a Duplex; it is the net socket. */
function asNetSocket(socket: Duplex): Socket {
  const candidate: unknown = socket;
  if (!isNetSocket(candidate)) {
    throw new Error("an upgrade request arrived without a network socket");
  }
  return candidate;
}

function isNetSocket(value: unknown): value is Socket {
  return (
    typeof value === "object" &&
    value !== null &&
    "remoteAddress" in value &&
    "setTimeout" in value
  );
}
