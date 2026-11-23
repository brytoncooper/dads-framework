import type { FastifyReply } from "fastify";
import { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";
import { ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE, type ChannelEnvelope } from "@dads-framework/core/contract";

import { HttpWiringError, RequestValidationError } from "../lib/http-errors.js";
import { requireSession } from "../lib/route/access.js";
import type { RawOpenApiOperation } from "../lib/route/define-raw-route.js";
import { routeGroup, type HttpRoute } from "../lib/route/route-group.js";
import { sseRoute, type SseRouteContext, type SseStream } from "../lib/route/sse-route.js";
import type { ChannelFanOut } from "./channel-fan-out.js";

const DEFAULT_CHANNEL_STREAM_PATH = "/channels/stream";
const DEFAULT_SCOPE_QUERY_PARAM = "scopeId";

export type ChannelAccessSubject = {
  readonly type: string;
  readonly id: string;
};

export type ChannelAccessCheckInput = {
  readonly subject: ChannelAccessSubject;
  readonly scopeId: string;
  readonly channel?: string;
};

export type ChannelAccessCheck = {
  check(input: ChannelAccessCheckInput): Promise<boolean>;
};

export type ChannelStreamRoutesOptions = {
  readonly channelFanOut: ChannelFanOut;
  readonly canAccessScope: ChannelAccessCheck;
  readonly channelAccess?: ReadonlyMap<string, ChannelAccessCheck>;
  readonly allowedChannels: readonly string[];
  readonly path?: string;
  readonly scopeQueryParam?: string;
  readonly heartbeatMs?: number;
};

function sendNotFoundRefusal(reply: FastifyReply): void {
  void reply
    .status(404)
    .header(ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE)
    .send({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource not found" },
    });
}

function validateStreamConfig(path: string, scopeQueryParam: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new HttpWiringError(`Channel stream path must be mount-relative, received "${path}"`);
  }
  if (scopeQueryParam.trim().length === 0 || scopeQueryParam === "channels") {
    throw new HttpWiringError(`Invalid channel stream scopeQueryParam "${scopeQueryParam}"`);
  }
}

function parseStreamQuery(
  rawQuery: unknown,
  scopeQueryParam: string,
): { readonly scopeId: string; readonly rawChannels: string | readonly string[] | undefined } {
  const schema = z.strictObject({
    [scopeQueryParam]: z.string().trim().min(1),
    channels: z.union([z.string(), z.array(z.string())]).optional(),
  });
  const parsed = schema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new RequestValidationError("query", parsed.error);
  }
  const scopeValue = parsed.data[scopeQueryParam];
  if (typeof scopeValue !== "string") {
    throw new HttpWiringError(`Channel stream scope query param "${scopeQueryParam}" did not parse as string`);
  }
  return { scopeId: scopeValue, rawChannels: parsed.data["channels"] };
}

function resolveRequestedChannels(
  rawChannels: string | readonly string[] | undefined,
  allowedSet: ReadonlySet<string>,
  allowedChannels: readonly string[],
): { readonly explicit: boolean; readonly channels: readonly string[] } {
  if (rawChannels === undefined) {
    return { explicit: false, channels: [...allowedChannels] };
  }
  const entries = typeof rawChannels === "string" ? [rawChannels] : rawChannels;
  const requested = entries
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && allowedSet.has(entry));
  return { explicit: true, channels: [...new Set(requested)] };
}

async function filterPermittedChannels(input: {
  readonly subject: SubjectRef;
  readonly scopeId: string;
  readonly channels: readonly string[];
  readonly explicit: boolean;
  readonly channelAccess: ReadonlyMap<string, ChannelAccessCheck> | undefined;
}): Promise<readonly string[] | null> {
  if (input.channelAccess === undefined) {
    return input.channels;
  }
  const permitted: string[] = [];
  for (const channel of input.channels) {
    const check = input.channelAccess.get(channel);
    if (check === undefined) {
      permitted.push(channel);
      continue;
    }
    const allowed = await check.check({ subject: input.subject, scopeId: input.scopeId, channel });
    if (allowed) {
      permitted.push(channel);
    } else if (input.explicit) {
      return null;
    }
  }
  if (!input.explicit && input.channels.length > 0 && permitted.length === 0) {
    return null;
  }
  return permitted;
}

function createDeliveryListener(input: {
  readonly subject: SubjectRef;
  readonly scopeId: string;
  readonly stream: SseStream;
  readonly channelAccess: ReadonlyMap<string, ChannelAccessCheck> | undefined;
  readonly isClosed: () => boolean;
}): (envelope: ChannelEnvelope) => Promise<void> {
  return async (envelope) => {
    if (input.isClosed()) {
      return;
    }
    const check = input.channelAccess?.get(envelope.channel);
    if (check !== undefined) {
      const allowed = await check.check({
        subject: input.subject,
        scopeId: input.scopeId,
        channel: envelope.channel,
      });
      if (!allowed || input.isClosed()) {
        return;
      }
    }
    input.stream.send(envelope);
  };
}

function buildStreamOpenApi(scopeQueryParam: string): RawOpenApiOperation {
  return {
    parameters: [
      {
        name: scopeQueryParam,
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1 },
        description: "Scope identifier whose channels should be streamed",
      },
      {
        name: "channels",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Optional comma-separated subset of allowed channels to subscribe to",
      },
    ],
    responses: {
      "200": {
        description: "Server-Sent Events channel stream",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
      "400": { description: "Invalid query parameters" },
      "401": { description: "Authentication required" },
      "404": { description: "Scope or channel not found" },
    },
  };
}

async function handleChannelStream(
  ctx: SseRouteContext,
  options: ChannelStreamRoutesOptions,
  scopeQueryParam: string,
  allowedSet: ReadonlySet<string>,
): Promise<void> {
  const { subject, request, reply, open } = ctx;
  if (subject === null) {
    throw new HttpWiringError("Channel stream route ran without an authenticated subject");
  }
  const { scopeId, rawChannels } = parseStreamQuery(request.query, scopeQueryParam);
  const scopeAllowed = await options.canAccessScope.check({ subject, scopeId });
  if (!scopeAllowed) {
    sendNotFoundRefusal(reply);
    return;
  }
  const selection = resolveRequestedChannels(rawChannels, allowedSet, options.allowedChannels);
  const permittedChannels = await filterPermittedChannels({
    subject,
    scopeId,
    channels: selection.channels,
    explicit: selection.explicit,
    channelAccess: options.channelAccess,
  });
  if (permittedChannels === null) {
    sendNotFoundRefusal(reply);
    return;
  }
  open((stream) => {
    let closed = false;
    const listener = createDeliveryListener({
      subject,
      scopeId,
      stream,
      channelAccess: options.channelAccess,
      isClosed: () => closed,
    });
    const unsubscribe = options.channelFanOut.subscribe(scopeId, permittedChannels, listener);
    return () => {
      closed = true;
      unsubscribe();
    };
  });
}

/**
 * Create the auth-checked SSE route group for streaming channel envelopes.
 *
 * Scope access is verified before the stream opens (denied callers receive 404
 * without leaking whether the scope exists). Channels with an entry in
 * `channelAccess` are checked both before opening and before delivering each
 * published envelope.
 */
export function createChannelStreamRoutes(options: ChannelStreamRoutesOptions): HttpRoute[] {
  const path = options.path ?? DEFAULT_CHANNEL_STREAM_PATH;
  const scopeQueryParam = options.scopeQueryParam ?? DEFAULT_SCOPE_QUERY_PARAM;
  validateStreamConfig(path, scopeQueryParam);
  const allowedSet = new Set(options.allowedChannels);

  return routeGroup("Channels", [
    sseRoute({
      path,
      summary: "Stream authorized channel events over Server-Sent Events",
      access: requireSession(),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      openapi: buildStreamOpenApi(scopeQueryParam),
      handler: (ctx) => handleChannelStream(ctx, options, scopeQueryParam, allowedSet),
    }),
  ]);
}
