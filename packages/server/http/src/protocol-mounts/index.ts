/**
 * `@dads-framework/http/protocol-mounts` — the bridge for mounting a fetch-style
 * handler (Better Auth's) on the kit's Fastify app. A secondary entry point
 * rather than part of the main barrel on purpose: only the two composition
 * roots register a protocol mount, so nothing else pays to compile the
 * WHATWG `Request` subclass here, and a program without the DOM lib never
 * meets it.
 *
 * The remote MCP endpoint and its RFC 9728 metadata live here for the same
 * reason: fetch handlers only a composition root mounts. The tool seam they
 * serve (`defineMcpTool`, `McpToolSet`) is in the main barrel, because
 * domains author tools.
 */
export {
  mountFetchHandler,
  type FetchHandler,
  type ProtocolExchange,
  type ProtocolMountOptions,
  type ProtocolRateLimit,
} from "./lib/protocol-mount/mount-fetch-handler.js";
export {
  toWebRequest,
  type IncomingProtocolRequest,
} from "./lib/protocol-mount/to-web-request.js";
export {
  createMcpEndpoint,
  type McpEndpoint,
  type McpEndpointOptions,
} from "./lib/mcp/mcp-endpoint.js";
export {
  LATEST_PROTOCOL_VERSION as MCP_LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS as MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpFailure,
  type McpServerInfo,
} from "./lib/mcp/mcp-methods.js";
export {
  createProtectedResourceMetadataHandler,
  protectedResourceMetadataDocument,
  type ProtectedResourceMetadataOptions,
} from "./lib/mcp/protected-resource-metadata.js";
