import { z } from "zod";

/**
 * The JSON-RPC 2.0 envelope MCP rides on: what one inbound message may be,
 * and the two answer shapes. Shapes only — what each method does lives in
 * `mcp-methods.ts`, and the HTTP framing in `mcp-endpoint.ts`.
 */

export type JsonRpcId = string | number;

export type JsonRpcSuccess = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}>;

export type JsonRpcFailure = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: Readonly<{ code: number; message: string; data?: unknown }>;
}>;

export type JsonRpcAnswer = JsonRpcSuccess | JsonRpcFailure;

/** The error codes this endpoint answers with (JSON-RPC 2.0 §5.1). */
export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

const idSchema = z.union([z.string(), z.number()]);

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

/** A client's answer to a server request. This server sends none, so it only acknowledges them. */
const answerSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema.nullable(),
});

export type JsonRpcRequest = z.infer<typeof requestSchema>;

/** One inbound message, sorted by what the endpoint owes it. */
export type InboundMessage =
  | Readonly<{ kind: "request"; request: JsonRpcRequest }>
  | Readonly<{ kind: "notification"; method: string }>
  | Readonly<{ kind: "answer" }>
  | Readonly<{ kind: "invalid" }>;

export function classifyMessage(message: unknown): InboundMessage {
  const request = requestSchema.safeParse(message);
  if (request.success) return { kind: "request", request: request.data };
  const notification = notificationSchema.safeParse(message);
  if (notification.success) {
    return { kind: "notification", method: notification.data.method };
  }
  if (answerSchema.safeParse(message).success && !hasMethod(message)) {
    return { kind: "answer" };
  }
  return { kind: "invalid" };
}

function hasMethod(message: unknown): boolean {
  return typeof message === "object" && message !== null && "method" in message;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
