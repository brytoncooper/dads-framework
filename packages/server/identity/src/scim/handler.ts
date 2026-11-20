import type { ScimGroupDirectory } from "./group-directory.js";
import { handleGroups } from "./group-handler.js";
import type { ScimDirectory, ScimUser } from "./directory.js";
import { scimDiscovery } from "./discovery.js";
import { compileUserPatch } from "./patch-user.js";
import {
  methodNotAllowed,
  patchSchema,
  ScimError,
  scimBody,
  scimError,
  scimJson,
  scimList,
  userSchema,
} from "./protocol.js";
import { parseScimUser } from "./user-data.js";
import { scimUserQuery } from "./user-query.js";
import { createUserProjection } from "./user-response.js";

export type ScimHandlerOptions = {
  /** Canonical public mount URL, used for paths and generated resource locations. */
  readonly baseUrl: string;
  readonly authenticate: (token: string) => Promise<string | null>;
  readonly directory: ScimDirectory;
  readonly groups?: ScimGroupDirectory;
};

function notFound(): ScimError {
  return new ScimError(404, "Resource not found.");
}

function decodePath(path: string): readonly string[] {
  try {
    return path.split("/").map(decodeURIComponent);
  } catch {
    throw notFound();
  }
}

function storedUser(result: ScimUser | "conflict" | null): ScimUser {
  if (!result) throw notFound();
  if (result === "conflict")
    throw new ScimError(409, "userName already exists.", "uniqueness");
  return result;
}

async function handleUsers(
  directory: ScimDirectory,
  tenantId: string,
  baseUrl: string,
  request: Request,
  params: URLSearchParams,
  id: string | undefined,
): Promise<Response> {
  const projection = createUserProjection(params);
  const location = (user: ScimUser) =>
    `${baseUrl}/Users/${encodeURIComponent(user.id)}`;
  const render = (user: ScimUser) => projection(user, location(user));
  const renderSaved = (user: ScimUser, status = 200) =>
    scimJson(render(user), status, { Location: location(user) });
  if (id === undefined) {
    switch (request.method) {
      case "GET": {
        const query = scimUserQuery(params);
        const result = await directory.list(tenantId, query);
        return scimList(
          result.users.map(render),
          result.totalResults,
          query.startIndex,
        );
      }
      case "POST": {
        const data = parseScimUser(await scimBody(request, userSchema));
        return renderSaved(
          storedUser(await directory.create(tenantId, data)),
          201,
        );
      }
      default:
        return methodNotAllowed("GET, POST");
    }
  }
  switch (request.method) {
    case "GET":
      return scimJson(render(storedUser(await directory.get(tenantId, id))));
    case "PUT": {
      const body = await scimBody(request, userSchema);
      return renderSaved(
        storedUser(
          await directory.update(tenantId, id, (current) =>
            parseScimUser(body, current.active),
          ),
        ),
      );
    }
    case "PATCH": {
      const change = compileUserPatch(await scimBody(request, patchSchema));
      return renderSaved(
        storedUser(await directory.update(tenantId, id, change)),
      );
    }
    case "DELETE":
      if (!(await directory.delete(tenantId, id))) throw notFound();
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    default:
      return methodNotAllowed("GET, PUT, PATCH, DELETE");
  }
}

export function createScimHandler(
  options: ScimHandlerOptions,
): (request: Request) => Promise<Response> {
  const url = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("The SCIM base URL must be a canonical HTTP URL.");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.origin}${basePath}`;
  return async (request) => {
    try {
      const tenantId = await authenticate(request, options.authenticate);
      const requestUrl = new URL(request.url);
      const parts = resourcePath(requestUrl.pathname, basePath);
      const [collection, id] = parts;
      if (collection?.toLowerCase() === "users") {
        return await handleUsers(
          options.directory,
          tenantId,
          baseUrl,
          request,
          requestUrl.searchParams,
          id,
        );
      }
      if (collection?.toLowerCase() === "groups" && options.groups) {
        return await handleGroups(
          options.groups,
          tenantId,
          baseUrl,
          request,
          requestUrl.searchParams,
          id,
        );
      }
      return discover(
        parts.join("/"),
        baseUrl,
        request,
        requestUrl.searchParams,
        options.groups !== undefined,
      );
    } catch (error) {
      return scimError(
        error instanceof ScimError
          ? error
          : new ScimError(500, "SCIM request failed."),
      );
    }
  };
}

function discover(
  path: string,
  baseUrl: string,
  request: Request,
  params: URLSearchParams,
  hasGroups: boolean,
): Response {
  const discovery = scimDiscovery(path, baseUrl, hasGroups);
  if (!discovery) throw notFound();
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (params.has("filter"))
    throw new ScimError(403, "Discovery does not support filtering.");
  return discovery;
}

async function authenticate(
  request: Request,
  lookup: ScimHandlerOptions["authenticate"],
): Promise<string> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)?.[1];
  const tenantId = token ? await lookup(token) : null;
  if (!tenantId)
    throw new ScimError(401, "A valid bearer credential is required.");
  return tenantId;
}

function resourcePath(path: string, basePath: string): readonly string[] {
  if (!path.startsWith(`${basePath}/`)) throw notFound();
  const parts = decodePath(path.slice(basePath.length + 1).replace(/\/$/, ""));
  if (parts.length > 2 || parts.some((part) => !part || part.includes("/")))
    throw notFound();
  return parts;
}
