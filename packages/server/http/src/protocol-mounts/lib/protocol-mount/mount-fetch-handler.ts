import type { FastifyPluginCallback, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

import type { FetchHandler } from "@dads-framework/core/contract";

import { createRateLimiter, type RateLimiter } from "../../../lib/request-pipeline/rate-limit.js";

import { toWebRequest } from "./to-web-request.js";

export type { FetchHandler } from "@dads-framework/core/contract";

/** One answered request, as the mount hands it to a caller's hook. */
export type ProtocolExchange = Readonly<{
  request: Request;
  response: Response;
  /** The Fastify request it arrived on — for what `Request` does not carry, such as the proxied protocol. */
  incoming: FastifyRequest;
}>;

export type ProtocolMountOptions = Readonly<{
  /** The methods forwarded to the handler. Defaults to GET and POST. */
  methods?: readonly HTTPMethods[];
  /**
   * `Set-Cookie` values appended to one answer after the handler's own — how
   * an application can clear its authorization-consistency cookie on sign-out.
   */
  extraSetCookies?: (exchange: ProtocolExchange) => readonly string[];
  /**
   * Also answer the prefix itself (`/mcp`), not only paths under it
   * (`/mcp/...`). Better Auth has no root endpoint; an MCP endpoint is
   * nothing but its root.
   */
  servePrefixRoot?: boolean;
  /** This mount's body ceiling, in place of the app-wide one. */
  bodyLimitBytes?: number;
  /**
   * Request header the handler reads the request's correlation id from. When
   * set, the mount writes Fastify's id there (inbound or minted), so the
   * handler's logs and the request row join on one id.
   */
  forwardRequestIdAs?: string;
  /**
   * Per-caller limits on single paths under this mount — the engine behind a
   * route's `rateLimit` capability: a fixed one-minute window per replica,
   * keyed by the caller's ip as the app's trusted proxy hops resolve it. A
   * caller past its budget gets 429 with `retry-after`, and the handler never
   * sees the request.
   */
  rateLimits?: readonly ProtocolRateLimit[];
}>;

/** One limited path: the full path, mount prefix included. */
export type ProtocolRateLimit = Readonly<{
  method: "GET" | "POST";
  path: string;
  perMinute: number;
}>;

type MountedRateLimit = Readonly<{
  limit: ProtocolRateLimit;
  limiter: RateLimiter;
}>;

function pathOf(url: string): string {
  const path = url.split("?")[0] ?? url;
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

/** Spends the caller's budget on a limited path: seconds to wait, or null when allowed. */
function rateLimitedFor(limits: readonly MountedRateLimit[], request: FastifyRequest): number | null {
  const path = pathOf(request.url);
  const matched = limits.find(({ limit }) => limit.method === request.method && limit.path === path);
  if (matched === undefined) return null;
  const verdict = matched.limiter.consume(`${matched.limit.method} ${matched.limit.path}`, request.ip);
  return verdict.allowed ? null : verdict.retryAfterSeconds;
}

async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
  extraSetCookies: readonly string[],
): Promise<void> {
  void reply.status(response.status);
  response.headers.forEach((value, key) => {
    void reply.header(key, value);
  });
  appendSetCookies(reply, extraSetCookies);
  const payload = Buffer.from(await response.arrayBuffer());
  await reply.send(payload.length > 0 ? payload : undefined);
}

function appendSetCookies(reply: FastifyReply, extraSetCookies: readonly string[]): void {
  if (extraSetCookies.length === 0) return;
  const existing = reply.getHeader("set-cookie");
  const current = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  void reply.header("set-cookie", [...current, ...extraSetCookies]);
}

/**
 * Mounts a fetch-style handler (Better Auth's, for one) on a Fastify scope.
 * Every content type arrives as raw bytes, the request crosses to a WHATWG
 * `Request` whose clones never share a stream (`to-web-request.ts`), and the
 * handler's `Response` is copied back — status, headers, body. Register it
 * with a literal prefix so the protocol-mount wall can read it
 * (docs/architecture/http-edge.md#protocol-mounts).
 */
export function mountFetchHandler(
  fetchHandler: FetchHandler,
  options: ProtocolMountOptions = {},
): FastifyPluginCallback {
  return (scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, parserDone) => {
      parserDone(null, body);
    });
    const rateLimits: MountedRateLimit[] = (options.rateLimits ?? []).map((limit) => ({
      limit,
      limiter: createRateLimiter({ perMinute: limit.perMinute }, Date.now),
    }));
    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const retryAfterSeconds = rateLimitedFor(rateLimits, request);
      if (retryAfterSeconds !== null) {
        await reply
          .status(429)
          .header("retry-after", String(retryAfterSeconds))
          .send({
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Rate limit exceeded — retry after the indicated delay",
            },
          });
        return;
      }
      // Stamped before the translation, so the request's clones carry it too.
      const webRequest = toWebRequest(
        options.forwardRequestIdAs === undefined
          ? request
          : {
              method: request.method,
              url: request.url,
              body: request.body,
              headers: {
                ...request.headers,
                [options.forwardRequestIdAs]: request.id,
              },
            },
      );
      const response = await fetchHandler.handler(webRequest);
      const extraSetCookies =
        options.extraSetCookies?.({
          request: webRequest,
          response,
          incoming: request,
        }) ?? [];
      await sendWebResponse(reply, response, extraSetCookies);
    };
    const bodyLimit = options.bodyLimitBytes === undefined ? {} : { bodyLimit: options.bodyLimitBytes };
    const urls = options.servePrefixRoot === true ? ["/", "/*"] : ["/*"];
    const method = [...(options.methods ?? ["GET", "POST"])];
    const explicitHead = options.methods === undefined ? {} : { exposeHeadRoute: false };
    for (const url of urls) {
      scope.route({ method, url, ...bodyLimit, ...explicitHead, handler });
    }
    done();
  };
}
