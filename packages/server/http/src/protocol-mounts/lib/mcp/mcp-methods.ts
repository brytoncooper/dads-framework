import { z } from "zod";

import { type AuditActor, runWithAuditActor } from "@dads-framework/core/audit-actor";
import type { AuditActorForSubject } from "../../../index.js";
import type { IsMcpToolSetOn, McpCaller, McpTool, McpToolResult, McpToolSet } from "../../../index.js";

import {
  JSON_RPC_ERROR,
  type JsonRpcAnswer,
  jsonRpcError,
  type JsonRpcFailure,
  type JsonRpcRequest,
  jsonRpcResult,
} from "./json-rpc.js";

/**
 * What each MCP method answers, for one authenticated caller. No HTTP here:
 * `mcp-endpoint.ts` has already checked the origin, the bearer and the body,
 * and turns an `insufficient-scope` outcome into the 403 the authorization
 * spec asks for.
 */

/** Newest first. A client asking for one of these gets it echoed back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

export type McpServerInfo = Readonly<{
  name: string;
  version: string;
  title?: string;
}>;

/** One caller, as the methods see them: who, and which scopes their token carries. */
export type McpSession = Readonly<{
  caller: McpCaller;
  scopes: readonly string[];
}>;

export type McpMethodOutcome =
  | Readonly<{ kind: "answer"; answer: JsonRpcAnswer }>
  | Readonly<{
      kind: "insufficient-scope";
      scope: string;
      answer: JsonRpcFailure;
    }>;

export type McpFailure = Readonly<{
  /** The tool that threw, or undefined when the endpoint itself failed. */
  tool: string | undefined;
  requestId: string;
  error: unknown;
}>;

export type McpMethodsOptions = Readonly<{
  toolSets: readonly McpToolSet[];
  serverInfo: McpServerInfo;
  /** Shown to the agent on `initialize`: how these tools fit together. */
  instructions?: string;
  /** A tool result larger than this, serialized, is refused rather than sent. */
  maxResultBytes: number;
  /**
   * Ceiling on the whole `tools/list` answer, serialized, with every set on.
   * Every connection loads it into the agent's context, so the endpoint
   * refuses to start past it rather than letting the listing grow unseen.
   * Absent: no ceiling.
   */
  maxListingBytes?: number;
  /**
   * Runs every tool as the caller, so audit rows name the person
   * (`carry-audit-actor.ts`) and the OAuth client they acted through.
   */
  auditActorForSubject?: AuditActorForSubject;
  /**
   * Whether a tool set is on for this caller. A set that is off is left out
   * of `tools/list` and its tools answer as unknown. Absent: every set is on.
   */
  isToolSetOn?: IsMcpToolSetOn;
  /** A tool or the endpoint threw: the agent gets a generic refusal, this gets the error. */
  onFailure?: (failure: McpFailure) => void;
}>;

export type McpMethods = {
  answer(request: JsonRpcRequest, session: McpSession): Promise<McpMethodOutcome>;
};

type RegisteredTool = Readonly<{
  tool: McpTool;
  toolSet: McpToolSet;
  scope: string;
  listing: Readonly<Record<string, unknown>>;
}>;

const toolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const initializeParamsSchema = z.object({
  protocolVersion: z.string().optional(),
});

export function createMcpMethods(options: McpMethodsOptions): McpMethods {
  const tools = registerTools(options.toolSets);
  requireListingWithin(tools, options.maxListingBytes);
  const isToolSetOn: IsMcpToolSetOn = options.isToolSetOn ?? (() => Promise.resolve(true));

  async function answer(request: JsonRpcRequest, session: McpSession): Promise<McpMethodOutcome> {
    switch (request.method) {
      case "initialize":
        return answered(jsonRpcResult(request.id, initializeResult(request)));
      case "ping":
        return answered(jsonRpcResult(request.id, {}));
      case "tools/list":
        return answered(
          jsonRpcResult(request.id, {
            tools: await listTools(tools, session, isToolSetOn),
          }),
        );
      case "tools/call":
        return callTool(request, session);
      default:
        return answered(jsonRpcError(request.id, JSON_RPC_ERROR.methodNotFound, `Method not found: ${request.method}`));
    }
  }

  function initializeResult(request: JsonRpcRequest): Record<string, unknown> {
    const params = initializeParamsSchema.safeParse(request.params ?? {});
    const requested = params.success ? params.data.protocolVersion : undefined;
    const protocolVersion =
      requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: options.serverInfo,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    };
  }

  async function callTool(request: JsonRpcRequest, session: McpSession): Promise<McpMethodOutcome> {
    const params = toolCallParamsSchema.safeParse(request.params);
    if (!params.success) {
      return answered(
        jsonRpcError(
          request.id,
          JSON_RPC_ERROR.invalidParams,
          "tools/call needs params.name (a string) and optional params.arguments (an object)",
        ),
      );
    }
    const registered = tools.get(params.data.name);
    if (registered === undefined || !(await isToolSetOn(registered.toolSet, session.caller))) {
      return answered(jsonRpcError(request.id, JSON_RPC_ERROR.invalidParams, `Unknown tool: ${params.data.name}`));
    }
    if (!session.scopes.includes(registered.scope)) {
      return {
        kind: "insufficient-scope",
        scope: registered.scope,
        answer: jsonRpcError(
          request.id,
          JSON_RPC_ERROR.invalidRequest,
          `${params.data.name} needs the "${registered.scope}" scope, which this sign-in did not grant`,
        ),
      };
    }
    const result = await runTool(registered.tool, params.data.arguments ?? {}, session.caller);
    return answered(jsonRpcResult(request.id, result));
  }

  async function runTool(tool: McpTool, input: Record<string, unknown>, caller: McpCaller): Promise<McpToolResult> {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return refusal(`The arguments for ${tool.name} are not valid:\n${z.prettifyError(parsed.error)}`);
    }
    let result: McpToolResult;
    try {
      // The raw arguments, not `parsed.data`: `defineMcpTool` parses them
      // itself, and parsing a transform's output a second time is not safe.
      result = await asCaller(caller, () => tool.run(input, caller));
    } catch (error) {
      options.onFailure?.({
        tool: tool.name,
        requestId: caller.requestId,
        error,
      });
      return refusal(`${tool.name} failed unexpectedly. Quote request id ${caller.requestId} if you report it.`);
    }
    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (size > options.maxResultBytes) {
      return refusal(
        `${tool.name} produced a ${size}-byte result, over this server's ${options.maxResultBytes}-byte limit. Ask for less at once.`,
      );
    }
    return result;
  }

  function asCaller<T>(caller: McpCaller, work: () => Promise<T>): Promise<T> {
    if (options.auditActorForSubject === undefined) return work();
    const actor = options.auditActorForSubject({
      subject: caller.subject,
      authenticatedSubject: caller.subject,
      requestId: caller.requestId,
    });
    return runWithAuditActor(withClient(actor, caller), work);
  }

  return { answer };
}

/** The audit actor's longest client id and name (`auditActorSchema`). */
const AUDIT_CLIENT_FIELD_MAX = 255;

/**
 * Tags the actor with the OAuth client behind the call, so every row the
 * tool writes reads "via Claude" on the Audit Log. A client's name is chosen
 * by whoever registered it, so it is clipped to what the actor admits rather
 * than refusing the call.
 */
function withClient(actor: AuditActor, caller: McpCaller): AuditActor {
  if (caller.clientId === undefined || caller.clientId === "") return actor;
  const clientName = caller.clientName?.trim().slice(0, AUDIT_CLIENT_FIELD_MAX);
  return {
    ...actor,
    clientId: caller.clientId.slice(0, AUDIT_CLIENT_FIELD_MAX),
    ...(clientName === undefined || clientName === "" ? {} : { clientName }),
  };
}

function answered(answer: JsonRpcAnswer): McpMethodOutcome {
  return { kind: "answer", answer };
}

function refusal(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** The caller's tools: granted by their token's scopes, in sets that are on for them. */
async function listTools(
  tools: ReadonlyMap<string, RegisteredTool>,
  session: McpSession,
  isToolSetOn: IsMcpToolSetOn,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const setsOn = new Map<McpToolSet, Promise<boolean>>();
  const isOn = (toolSet: McpToolSet): Promise<boolean> => {
    const known = setsOn.get(toolSet);
    if (known !== undefined) return known;
    const decided = isToolSetOn(toolSet, session.caller);
    setsOn.set(toolSet, decided);
    return decided;
  };
  const granted = [...tools.values()].filter((registered) => session.scopes.includes(registered.scope));
  const on = await Promise.all(granted.map((registered) => isOn(registered.toolSet)));
  return granted.filter((_, index) => on[index] === true).map((registered) => registered.listing);
}

/** Every tool by name, with its listing rendered once. Two tools may not share a name. */
function registerTools(toolSets: readonly McpToolSet[]): ReadonlyMap<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  for (const toolSet of toolSets) {
    for (const tool of toolSet.tools) {
      if (tools.has(tool.name)) {
        throw new Error(`MCP tool "${tool.name}" is defined twice; tool names are one namespace across every tool set`);
      }
      tools.set(tool.name, {
        tool,
        toolSet,
        scope: toolSet.scope,
        listing: toolListing(tool),
      });
    }
  }
  return tools;
}

function requireListingWithin(tools: ReadonlyMap<string, RegisteredTool>, maxListingBytes: number | undefined): void {
  if (maxListingBytes === undefined) return;
  const listing = [...tools.values()].map((registered) => registered.listing);
  const size = Buffer.byteLength(JSON.stringify({ tools: listing }), "utf8");
  if (size > maxListingBytes) {
    throw new Error(
      `The MCP tools/list answer is ${size} bytes, over its ${maxListingBytes}-byte budget; shorten tool descriptions or split a tool set behind its own scope`,
    );
  }
}

function toolListing(tool: McpTool): Readonly<Record<string, unknown>> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputJsonSchema(tool),
    // `title` again inside the annotations: 2025-03-26 clients read it there.
    annotations: { title: tool.title, ...tool.annotations },
  };
}

function inputJsonSchema(tool: McpTool): Readonly<Record<string, unknown>> {
  const schema = z.toJSONSchema(tool.inputSchema, {
    io: "input",
    unrepresentable: "any",
  });
  delete schema.$schema;
  if (schema.type !== "object") {
    throw new Error(
      `MCP tool "${tool.name}" needs an object input schema; MCP lists tool inputs as JSON Schema objects`,
    );
  }
  return schema;
}
