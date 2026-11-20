/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for an MCP endpoint: the
 * document an MCP client reads, after its first 401, to learn which
 * authorization server issues tokens for this resource and which scopes to
 * ask for. Public and static, so it is safe to cache briefly.
 */

export type ProtectedResourceMetadataOptions = Readonly<{
  /** The resource identifier: the MCP endpoint's absolute URL, e.g. `https://api.example.com/mcp`. */
  resource: string;
  /** Issuer identifiers of the authorization servers that mint tokens for it. */
  authorizationServers: readonly string[];
  scopesSupported: readonly string[];
  resourceName?: string;
}>;

export function protectedResourceMetadataDocument(
  options: ProtectedResourceMetadataOptions,
): Readonly<Record<string, unknown>> {
  return {
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    scopes_supported: options.scopesSupported,
    bearer_methods_supported: ["header"],
    ...(options.resourceName === undefined
      ? {}
      : { resource_name: options.resourceName }),
  };
}

/** Answers GET (and HEAD) with the document; anything else is 405. */
export function createProtectedResourceMetadataHandler(
  options: ProtectedResourceMetadataOptions,
): (request: Request) => Promise<Response> {
  const body = JSON.stringify(protectedResourceMetadataDocument(options));
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Promise.resolve(
        new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }),
      );
    }
    return Promise.resolve(
      new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
        },
      }),
    );
  };
}
