import type { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";

/**
 * The signed-in person behind one MCP request. The endpoint resolves it from
 * the OAuth bearer before any tool runs; tools act as this subject through the
 * same operations the HTTP routes call.
 */
export type McpCaller = Readonly<{
  subject: SubjectRef;
  requestId: string;
  /**
   * The OAuth client the person connected (Claude, ChatGPT, or any MCP
   * client): its registered client id. Every audit row a tool writes names
   * it. Absent when the bearer resolver does not say.
   */
  clientId?: string;
  /** The name that client registered under, when it gave one. */
  clientName?: string;
}>;

/** What a tool hands back, in MCP's own content shapes. */
export type McpContent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; data: string; mimeType: string }>
  | Readonly<{
      type: "resource";
      resource: Readonly<{ uri: string; mimeType: string; blob: string }>;
    }>;

export type McpToolResult = Readonly<{
  content: readonly McpContent[];
  structuredContent?: Readonly<Record<string, unknown>>;
  /** A refusal the agent should read and correct, not a protocol failure. */
  isError?: boolean;
}>;

export type McpToolAnnotations = Readonly<{
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}>;

/** One tool after its input type is erased for the registry. */
export type McpTool = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations?: McpToolAnnotations;
  run: (input: unknown, caller: McpCaller) => Promise<McpToolResult>;
}>;

/** A domain's contribution to the endpoint, all under one OAuth scope. */
export type McpToolSet = Readonly<{
  scope: string;
  tools: readonly McpTool[];
  /**
   * The feature flag that rolls this set out, if any. The kit only carries
   * it: the composition root's `isToolSetOn` decides what it means for a
   * caller, and a set that is off is neither listed nor callable.
   */
  featureFlag?: string;
}>;

/** Whether one tool set is on for one caller (its feature flag, typically). */
export type IsMcpToolSetOn = (
  toolSet: McpToolSet,
  caller: McpCaller,
) => Promise<boolean>;

/**
 * Types one tool's input against its schema. The endpoint parses arguments with
 * `inputSchema` before `run` sees them, so `run` only ever gets parsed input.
 */
export function defineMcpTool<Schema extends z.ZodType>(definition: {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations?: McpToolAnnotations;
  run: (input: z.output<Schema>, caller: McpCaller) => Promise<McpToolResult>;
}): McpTool {
  return {
    ...definition,
    run: async (input, caller) =>
      definition.run(definition.inputSchema.parse(input), caller),
  };
}

/**
 * Turns the request's `Authorization` header into the person it was issued
 * to, or null for a missing, unknown, expired or revoked token, or a person
 * who may no longer sign in. Implemented by the identity domain.
 */
export type ResolveMcpBearer = (
  authorization: string | undefined,
) => Promise<Readonly<{
  userId: string;
  scopes: readonly string[];
  /** The OAuth client the token was issued to. */
  clientId?: string;
  /** The name that client registered under, when it gave one. */
  clientName?: string;
}> | null>;
