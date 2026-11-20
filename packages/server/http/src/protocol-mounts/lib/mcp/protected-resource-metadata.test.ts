import { describe, expect, it } from "vitest";

import { toWebRequest } from "../protocol-mount/to-web-request.js";
import { createProtectedResourceMetadataHandler } from "./protected-resource-metadata.js";

function metadataRequest(method: string): Request {
  return toWebRequest({
    method,
    url: "/.well-known/oauth-protected-resource",
    headers: { host: "api.example.com" },
    body: undefined,
  });
}

const options = {
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://app.example.com/api/auth"],
  scopesSupported: ["templates"],
  resourceName: "Example API",
};

describe("protected resource metadata (RFC 9728)", () => {
  it("serves the document a client discovers the authorization server from", async () => {
    const handler = createProtectedResourceMetadataHandler(options);
    const response = await handler(metadataRequest("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      resource: "https://api.example.com/mcp",
      authorization_servers: ["https://app.example.com/api/auth"],
      scopes_supported: ["templates"],
      bearer_methods_supported: ["header"],
      resource_name: "Example API",
    });
  });

  it("refuses anything but a read", async () => {
    const handler = createProtectedResourceMetadataHandler(options);
    const response = await handler(metadataRequest("POST"));
    expect(response.status).toBe(405);
  });
});
