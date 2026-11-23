import { describe, expect, it } from "vitest";
import { z } from "zod";

import { currentAuditActor } from "@dads-framework/core/audit-actor";
import {
  defineMcpTool,
  type McpCaller,
  type ResolveMcpBearer,
} from "../../../index.js";
import { REQUEST_ID_HEADER } from "@dads-framework/core/contract";

import { toWebRequest } from "../protocol-mount/to-web-request.js";
import { createMcpEndpoint, type McpEndpointOptions } from "./mcp-endpoint.js";

const METADATA_URL =
  "https://api.example.com/.well-known/oauth-protected-resource/mcp";
const VALID_TOKEN = "Bearer good-token";
const READ_ONLY_TOKEN = "Bearer read-only-token";
const CLIENT_TOKEN = "Bearer client-token";

const resolveBearer: ResolveMcpBearer = (authorization) => {
  if (authorization === VALID_TOKEN) {
    return Promise.resolve({
      userId: "user-1",
      scopes: ["templates:read", "templates:write"],
    });
  }
  if (authorization === CLIENT_TOKEN) {
    return Promise.resolve({
      userId: "user-3",
      scopes: ["templates:read"],
      clientId: "client-claude",
      clientName: "Claude",
    });
  }
  if (authorization === READ_ONLY_TOKEN) {
    return Promise.resolve({ userId: "user-2", scopes: ["templates:read"] });
  }
  return Promise.resolve(null);
};

const callers: McpCaller[] = [];

const echoTool = defineMcpTool({
  name: "echo",
  title: "Echo",
  description: "Says it back.",
  inputSchema: z.object({
    text: z.string().min(1),
    times: z.number().int().positive().default(1),
  }),
  annotations: { readOnlyHint: true },
  run: (input, caller) => {
    callers.push(caller);
    return Promise.resolve({
      content: [{ type: "text", text: input.text.repeat(input.times) }],
    });
  },
});

const publishTool = defineMcpTool({
  name: "publish",
  title: "Publish",
  description: "Writes something.",
  inputSchema: z.object({}),
  run: () => Promise.resolve({ content: [{ type: "text", text: "done" }] }),
});

const brokenTool = defineMcpTool({
  name: "broken",
  title: "Broken",
  description: "Always throws.",
  inputSchema: z.object({}),
  run: () => Promise.reject(new Error("secret database detail")),
});

const hugeTool = defineMcpTool({
  name: "huge",
  title: "Huge",
  description: "Answers too much.",
  inputSchema: z.object({}),
  run: () =>
    Promise.resolve({ content: [{ type: "text", text: "x".repeat(5_000) }] }),
});

const actorTool = defineMcpTool({
  name: "who-am-i",
  title: "Who am I",
  description: "Reports the audit actor.",
  inputSchema: z.object({}),
  run: () =>
    Promise.resolve({
      content: [{ type: "text", text: JSON.stringify(currentAuditActor()) }],
    }),
});

function endpoint(overrides: Partial<McpEndpointOptions> = {}) {
  return createMcpEndpoint({
    toolSets: [
      {
        scope: "templates:read",
        tools: [echoTool, brokenTool, hugeTool, actorTool],
      },
      { scope: "templates:write", tools: [publishTool] },
    ],
    serverInfo: { name: "command", version: "1.0.0" },
    resolveBearer,
    resourceMetadataUrl: METADATA_URL,
    allowedOrigins: ["https://app.example.com"],
    maxRequestBytes: 10_000,
    maxResultBytes: 2_000,
    ...overrides,
  });
}

/** A fetch request as the protocol mount hands one over (`toWebRequest`). */
function webRequest(
  method: string,
  headers: Record<string, string>,
  body?: string,
): Request {
  return toWebRequest({
    method,
    url: "/mcp",
    headers: { host: "api.example.com", ...headers },
    body: body === undefined ? undefined : Buffer.from(body),
  });
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return webRequest(
    "POST",
    {
      authorization: VALID_TOKEN,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [REQUEST_ID_HEADER]: "req-1",
      ...headers,
    },
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

function rpc(method: string, params?: unknown, id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

const answerSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

async function answerOf(response: Response) {
  return answerSchema.parse(await response.json());
}

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean().optional(),
});

async function toolResultOf(response: Response) {
  const answer = await answerOf(response);
  return toolResultSchema.parse(answer.result);
}

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      annotations: z.record(z.string(), z.unknown()),
    }),
  ),
});

describe("MCP endpoint: transport", () => {
  it("answers GET with 405 and names POST as the only method", async () => {
    const response = await endpoint()(
      webRequest("GET", { authorization: VALID_TOKEN }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers a notification with 202 and no body", async () => {
    const response = await endpoint()(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("acknowledges a client's JSON-RPC response with 202", async () => {
    const response = await endpoint()(
      post({ jsonrpc: "2.0", id: 7, result: {} }),
    );
    expect(response.status).toBe(202);
  });

  it("refuses a body that is not JSON with a parse error", async () => {
    const response = await endpoint()(post("{not json"));
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error?.code).toBe(-32700);
  });

  it("refuses JSON that is not a JSON-RPC message", async () => {
    const response = await endpoint()(post({ hello: "world" }));
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error?.code).toBe(-32600);
  });

  it("refuses a batch", async () => {
    const response = await endpoint()(post([rpc("ping")]));
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error?.message).toMatch(/batches/);
  });

  it("refuses a body that is not application/json", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { "content-type": "text/plain" }),
    );
    expect(response.status).toBe(415);
  });

  it("refuses a body over the request ceiling", async () => {
    const response = await endpoint()(
      post(rpc("ping", { padding: "x".repeat(20_000) })),
    );
    expect(response.status).toBe(413);
  });

  it("refuses an unsupported MCP-Protocol-Version header", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { "mcp-protocol-version": "2023-01-01" }),
    );
    expect(response.status).toBe(400);
    expect((await answerOf(response)).error?.message).toMatch(
      /Unsupported MCP-Protocol-Version/,
    );
  });

  it("accepts a supported MCP-Protocol-Version header", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { "mcp-protocol-version": "2025-06-18" }),
    );
    expect(response.status).toBe(200);
    expect(await answerOf(response)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("answers an unknown method with method-not-found", async () => {
    const response = await endpoint()(post(rpc("resources/list")));
    expect(response.status).toBe(200);
    expect((await answerOf(response)).error?.code).toBe(-32601);
  });

  it("never caches an answer", async () => {
    const response = await endpoint()(post(rpc("ping")));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("MCP endpoint: origin guard", () => {
  it("refuses a browser origin outside the allowlist", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });

  it("serves an allowed origin", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { origin: "https://app.example.com" }),
    );
    expect(response.status).toBe(200);
  });

  it("serves a request with no origin (a server-side client)", async () => {
    const response = await endpoint()(post(rpc("ping")));
    expect(response.status).toBe(200);
  });
});

describe("MCP endpoint: bearer", () => {
  it("challenges a request with no token, naming the resource metadata", async () => {
    const response = await endpoint()(
      post(rpc("initialize"), { authorization: "" }),
    );
    // An empty header is still a header; a missing one is the plain challenge.
    expect(response.status).toBe(401);

    const missing = await endpoint()(
      webRequest(
        "POST",
        { "content-type": "application/json" },
        JSON.stringify(rpc("initialize")),
      ),
    );
    expect(missing.status).toBe(401);
    const challenge = missing.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(challenge).toContain('scope="templates:read templates:write"');
    expect(challenge).not.toContain("error=");
  });

  it("challenges an unknown token with invalid_token", async () => {
    const response = await endpoint()(
      post(rpc("ping"), { authorization: "Bearer revoked" }),
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
  });
});

describe("MCP endpoint: initialize", () => {
  it.each(["2025-06-18", "2025-03-26"])(
    "echoes the supported protocol version %s",
    async (version) => {
      const response = await endpoint()(
        post(
          rpc("initialize", {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          }),
        ),
      );
      const answer = await answerOf(response);
      expect(answer.result).toEqual({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "command", version: "1.0.0" },
      });
    },
  );

  it("offers the latest version when the client's is unknown", async () => {
    const response = await endpoint({ instructions: "Start with echo." })(
      post(rpc("initialize", { protocolVersion: "2099-01-01" })),
    );
    expect((await answerOf(response)).result).toMatchObject({
      protocolVersion: "2025-06-18",
      instructions: "Start with echo.",
    });
  });
});

describe("MCP endpoint: tools/list", () => {
  it("lists every tool the token's scopes reach, with JSON Schema inputs", async () => {
    const response = await endpoint()(post(rpc("tools/list")));
    const { tools } = toolListSchema.parse((await answerOf(response)).result);
    expect(tools.map((tool) => tool.name)).toEqual([
      "echo",
      "broken",
      "huge",
      "who-am-i",
      "publish",
    ]);
    const echo = tools[0];
    expect(echo).toMatchObject({
      title: "Echo",
      description: "Says it back.",
      annotations: { title: "Echo", readOnlyHint: true },
    });
    expect(echo?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        times: { type: "integer", default: 1 },
      },
      required: ["text"],
    });
    expect(echo?.inputSchema).not.toHaveProperty("$schema");
  });

  it("hides a tool set whose scope the token lacks", async () => {
    const response = await endpoint()(
      post(rpc("tools/list"), { authorization: READ_ONLY_TOKEN }),
    );
    const { tools } = toolListSchema.parse((await answerOf(response)).result);
    expect(tools.map((tool) => tool.name)).not.toContain("publish");
  });

  it("hides and refuses a tool set that is off for the caller, asking once per set", async () => {
    const asked: { flag: string | undefined; userId: string }[] = [];
    const flagged = endpoint({
      toolSets: [
        { scope: "templates:read", tools: [echoTool, actorTool] },
        {
          scope: "templates:write",
          tools: [publishTool],
          featureFlag: "example.templates.publish",
        },
      ],
      isToolSetOn: (toolSet, caller) => {
        asked.push({ flag: toolSet.featureFlag, userId: caller.subject.id });
        return Promise.resolve(toolSet.featureFlag === undefined);
      },
    });

    const listed = await flagged(post(rpc("tools/list")));
    const { tools } = toolListSchema.parse((await answerOf(listed)).result);
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "who-am-i"]);
    expect(asked).toEqual([
      { flag: undefined, userId: "user-1" },
      { flag: "example.templates.publish", userId: "user-1" },
    ]);

    const called = await flagged(
      post(rpc("tools/call", { name: "publish", arguments: {} })),
    );
    expect(called.status).toBe(200);
    expect((await answerOf(called)).error).toMatchObject({
      message: "Unknown tool: publish",
    });
  });

  it("refuses to build when the whole tools/list answer is over its byte budget", () => {
    expect(() => endpoint({ maxListingBytes: 200 })).toThrow(
      /tools\/list answer is \d+ bytes, over its 200-byte budget/,
    );
    expect(() => endpoint({ maxListingBytes: 100_000 })).not.toThrow();
  });

  it("refuses to build with two tools of one name", () => {
    expect(() =>
      endpoint({
        toolSets: [
          { scope: "a", tools: [echoTool] },
          { scope: "b", tools: [echoTool] },
        ],
      }),
    ).toThrow(/defined twice/);
  });

  it("refuses to build with a tool whose input is not an object", () => {
    const scalar = defineMcpTool({
      name: "scalar",
      title: "Scalar",
      description: "Takes a string.",
      inputSchema: z.string(),
      run: () => Promise.resolve({ content: [] }),
    });
    expect(() =>
      endpoint({ toolSets: [{ scope: "a", tools: [scalar] }] }),
    ).toThrow(/object input schema/);
  });
});

describe("MCP endpoint: tools/call", () => {
  it("runs the tool as the bearer's user, with the request id", async () => {
    callers.length = 0;
    const response = await endpoint()(
      post(
        rpc("tools/call", {
          name: "echo",
          arguments: { text: "hi", times: 2 },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await toolResultOf(response)).toEqual({
      content: [{ type: "text", text: "hihi" }],
    });
    expect(callers).toEqual([
      { subject: { type: "user", id: "user-1" }, requestId: "req-1" },
    ]);
  });

  it("turns invalid arguments into a readable tool error, not a protocol error", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { name: "echo", arguments: { text: "" } })),
    );
    const result = await toolResultOf(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/arguments for echo are not valid/);
    expect(result.content[0]?.text).toMatch(/text/);
  });

  it("treats missing arguments as an empty object", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { name: "publish" })),
    );
    expect(await toolResultOf(response)).toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("answers an unknown tool with a JSON-RPC error", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { name: "nope", arguments: {} })),
    );
    const answer = await answerOf(response);
    expect(answer.error?.code).toBe(-32602);
    expect(answer.error?.message).toMatch(/Unknown tool: nope/);
  });

  it("answers malformed call params with invalid-params", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { arguments: {} })),
    );
    expect((await answerOf(response)).error?.code).toBe(-32602);
  });

  it("answers 403 insufficient_scope for a tool outside the token's scopes", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { name: "publish" }), {
        authorization: READ_ONLY_TOKEN,
      }),
    );
    expect(response.status).toBe(403);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="templates:write"');
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect((await answerOf(response)).id).toBe(1);
  });

  it("hides a tool's thrown error from the agent and hands it to onFailure", async () => {
    const failures: unknown[] = [];
    const response = await endpoint({
      onFailure: (failure) => failures.push(failure),
    })(post(rpc("tools/call", { name: "broken" })));
    const result = await toolResultOf(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("req-1");
    expect(result.content[0]?.text).not.toContain("secret");
    expect(failures).toEqual([
      expect.objectContaining({ tool: "broken", requestId: "req-1" }),
    ]);
  });

  it("refuses a result over the size cap", async () => {
    const response = await endpoint()(
      post(rpc("tools/call", { name: "huge" })),
    );
    const result = await toolResultOf(response);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /over this server's 2000-byte limit/,
    );
  });

  it("runs the tool as the caller's audit actor when a mapper is wired", async () => {
    const response = await endpoint({
      auditActorForSubject: ({ subject, requestId }) => ({
        kind: "user",
        id: subject?.id ?? "nobody",
        requestId,
      }),
    })(post(rpc("tools/call", { name: "who-am-i" })));
    const result = await toolResultOf(response);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
      kind: "user",
      id: "user-1",
      requestId: "req-1",
    });
  });

  it("tags the audit actor and the caller with the OAuth client behind the token", async () => {
    callers.length = 0;
    const tagged = endpoint({
      auditActorForSubject: ({ subject, requestId }) => ({
        kind: "user",
        id: subject?.id ?? "nobody",
        requestId,
      }),
    });
    const actorResponse = await tagged(
      post(rpc("tools/call", { name: "who-am-i" }), {
        authorization: CLIENT_TOKEN,
      }),
    );
    await tagged(
      post(rpc("tools/call", { name: "echo", arguments: { text: "a" } }), {
        authorization: CLIENT_TOKEN,
      }),
    );
    const result = await toolResultOf(actorResponse);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      kind: "user",
      id: "user-3",
      requestId: "req-1",
      clientId: "client-claude",
      clientName: "Claude",
    });
    expect(callers[0]).toMatchObject({
      clientId: "client-claude",
      clientName: "Claude",
    });
  });

  it("leaves the audit actor untagged when the token names no client", async () => {
    const response = await endpoint({
      auditActorForSubject: ({ subject, requestId }) => ({
        kind: "user",
        id: subject?.id ?? "nobody",
        requestId,
      }),
    })(post(rpc("tools/call", { name: "who-am-i" })));
    const result = await toolResultOf(response);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      kind: "user",
      id: "user-1",
      requestId: "req-1",
    });
  });

  it("mints a request id when the request carries none", async () => {
    callers.length = 0;
    const request = webRequest(
      "POST",
      { authorization: VALID_TOKEN, "content-type": "application/json" },
      JSON.stringify(
        rpc("tools/call", { name: "echo", arguments: { text: "a" } }),
      ),
    );
    await endpoint()(request);
    expect(callers[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("MCP endpoint: failure", () => {
  it("answers 500 in JSON-RPC shape when the bearer resolver throws", async () => {
    const failures: unknown[] = [];
    const response = await endpoint({
      resolveBearer: () => Promise.reject(new Error("db down")),
      onFailure: (failure) => failures.push(failure),
    })(post(rpc("ping")));
    expect(response.status).toBe(500);
    expect((await answerOf(response)).error?.code).toBe(-32603);
    expect(failures).toEqual([expect.objectContaining({ tool: undefined })]);
  });
});
