import { randomUUID } from "node:crypto";

import type { ResolveMcpBearer } from "../../../index.js";
import { REQUEST_ID_HEADER } from "@dads-framework/contract";

import {
  classifyMessage,
  JSON_RPC_ERROR,
  type JsonRpcAnswer,
  jsonRpcError,
  type JsonRpcRequest,
} from "./json-rpc.js";
import {
  createMcpMethods,
  type McpMethodsOptions,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./mcp-methods.js";

/**
 * A remote MCP server as one fetch handler: the Streamable HTTP transport,
 * stateless and answering in plain JSON (no SSE, no `Mcp-Session-Id`), behind
 * OAuth bearer tokens the way the MCP authorization spec describes a
 * protected resource. Framework-free, like Better Auth's handler, so a
 * product mounts it with `mountFetchHandler`
 * (docs/architecture/http-edge.md#protocol-mounts).
 *
 * The order of the walls is the order a request meets them: origin (the
 * DNS-rebinding guard), method, bearer, then the body. A caller who is not
 * signed in learns nothing about the body rules.
 */

export type McpEndpointOptions = McpMethodsOptions &
  Readonly<{
    resolveBearer: ResolveMcpBearer;
    /** This resource's RFC 9728 metadata URL, named in every 401 and 403. */
    resourceMetadataUrl: string;
    /**
     * Browser origins allowed to call. A request with no `Origin` is a
     * server-side client and passes; one with any other origin is refused.
     */
    allowedOrigins: readonly string[];
    /** The request body's ceiling; the mount's own body limit should match it. */
    maxRequestBytes: number;
    /** The request's correlation id. Defaults to `x-request-id`, else a new one. */
    requestIdOf?: (request: Request) => string;
  }>;

export type McpEndpoint = (request: Request) => Promise<Response>;

/** Version a client that sends no `MCP-Protocol-Version` header is assumed to speak. */
const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  const methods = createMcpMethods(options);
  const allowedOrigins = new Set(options.allowedOrigins.map(normalizeOrigin));
  const scopes = [
    ...new Set(options.toolSets.map((toolSet) => toolSet.scope)),
  ].join(" ");
  const challenge = (parameters: Readonly<Record<string, string>>): string =>
    bearerChallenge({
      resource_metadata: options.resourceMetadataUrl,
      ...(scopes.length > 0 ? { scope: scopes } : {}),
      ...parameters,
    });
  const requestIdOf =
    options.requestIdOf ??
    ((request: Request) =>
      request.headers.get(REQUEST_ID_HEADER) ?? randomUUID());

  async function handle(request: Request): Promise<Response> {
    const transportRefusal = refuseTransport(request, allowedOrigins);
    if (transportRefusal !== null) return transportRefusal;

    const authorization = request.headers.get("authorization") ?? undefined;
    const grant =
      authorization === undefined
        ? null
        : await options.resolveBearer(authorization);
    if (grant === null) return unauthorized(authorization);

    const headerRefusal = refuseHeaders(request);
    if (headerRefusal !== null) return headerRefusal;

    const read = await readJsonRpcRequest(request, options.maxRequestBytes);
    if (read.kind === "respond") return read.response;

    const outcome = await methods.answer(read.request, {
      caller: {
        subject: { type: "user", id: grant.userId },
        requestId: requestIdOf(request),
        ...(grant.clientId === undefined ? {} : { clientId: grant.clientId }),
        ...(grant.clientName === undefined
          ? {}
          : { clientName: grant.clientName }),
      },
      scopes: grant.scopes,
    });
    if (outcome.kind === "insufficient-scope") {
      return json(403, outcome.answer, {
        "www-authenticate": bearerChallenge({
          error: "insufficient_scope",
          scope: outcome.scope,
          resource_metadata: options.resourceMetadataUrl,
          error_description: `This tool needs the "${outcome.scope}" scope`,
        }),
      });
    }
    return json(200, outcome.answer);
  }

  function unauthorized(authorization: string | undefined): Response {
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          authorization === undefined
            ? challenge({})
            : challenge({
                error: "invalid_token",
                error_description:
                  "The access token is missing, expired, revoked, or its user can no longer sign in",
              }),
      },
    });
  }

  return async (request) => {
    try {
      return await handle(request);
    } catch (error) {
      options.onFailure?.({
        tool: undefined,
        requestId: requestIdOf(request),
        error,
      });
      return failure(
        500,
        JSON_RPC_ERROR.internalError,
        "The MCP endpoint failed unexpectedly",
      );
    }
  };
}

/** The walls before the bearer: origin (the DNS-rebinding guard), then method. */
function refuseTransport(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response | null {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(normalizeOrigin(origin))) {
    return failure(403, JSON_RPC_ERROR.invalidRequest, "Origin not allowed");
  }
  if (request.method !== "POST") {
    // Stateless and JSON-only: there is no stream to open with GET and no
    // session to end with DELETE (Streamable HTTP lets a server say so).
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  return null;
}

/** The walls after the bearer and before the body: protocol version, content type. */
function refuseHeaders(request: Request): Response | null {
  const protocolVersion =
    request.headers.get("mcp-protocol-version") ?? ASSUMED_PROTOCOL_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return failure(
      400,
      JSON_RPC_ERROR.invalidRequest,
      `Unsupported MCP-Protocol-Version ${protocolVersion}; this server speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    );
  }
  if (!isJson(request.headers.get("content-type"))) {
    return failure(
      415,
      JSON_RPC_ERROR.invalidRequest,
      "Send the JSON-RPC message as application/json",
    );
  }
  return null;
}

type ReadOutcome =
  | Readonly<{ kind: "request"; request: JsonRpcRequest }>
  | Readonly<{ kind: "respond"; response: Response }>;

/** The body wall: size, JSON, one message, a JSON-RPC request owed an answer. */
async function readJsonRpcRequest(
  request: Request,
  maxRequestBytes: number,
): Promise<ReadOutcome> {
  const respond = (response: Response): ReadOutcome => ({
    kind: "respond",
    response,
  });
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
    return respond(
      failure(
        413,
        JSON_RPC_ERROR.invalidRequest,
        `The message is over this server's ${maxRequestBytes}-byte limit`,
      ),
    );
  }
  const message = parseJson(body);
  if (message === PARSE_FAILED) {
    return respond(
      failure(400, JSON_RPC_ERROR.parseError, "The body is not JSON"),
    );
  }
  if (Array.isArray(message)) {
    return respond(
      failure(
        400,
        JSON_RPC_ERROR.invalidRequest,
        "JSON-RPC batches are not supported; send one message per request",
      ),
    );
  }

  const inbound = classifyMessage(message);
  if (inbound.kind === "invalid") {
    return respond(
      failure(
        400,
        JSON_RPC_ERROR.invalidRequest,
        "The body is not a JSON-RPC 2.0 request, notification, or response",
      ),
    );
  }
  if (inbound.kind !== "request") {
    // `notifications/initialized` and friends: accepted, nothing owed.
    return respond(new Response(null, { status: 202 }));
  }
  return { kind: "request", request: inbound.request };
}

const PARSE_FAILED = Symbol("parse-failed");

function parseJson(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return PARSE_FAILED;
  }
}

function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** `Bearer key="value", …` — RFC 6750 §3, values quoted with `"` and `\` escaped. */
function bearerChallenge(parameters: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(parameters).map(
    ([key, value]) => `${key}="${value.replace(/["\\]/g, "\\$&")}"`,
  );
  return `Bearer ${pairs.join(", ")}`;
}

function failure(status: number, code: number, message: string): Response {
  return json(status, jsonRpcError(null, code, message));
}

function json(
  status: number,
  answer: JsonRpcAnswer,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(answer), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
