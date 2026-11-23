import type { ScimGroup, ScimGroupDirectory, ScimGroupQuery } from "./group-directory.js";
import { parseScimGroup } from "./group-data.js";
import { compileGroupPatch } from "./patch-group.js";
import {
  attributePath,
  groupSchema,
  methodNotAllowed,
  patchSchema,
  ScimError,
  scimBody,
  scimJson,
  scimList,
} from "./protocol.js";
import { parseFilterLiteral, scimPage } from "./user-query.js";
import { createResourceProjection } from "./resource-projection.js";

function parseGroupFilter(filter: string): NonNullable<ScimGroupQuery["filter"]> {
  const match = /^(\S+)\s+eq\s+("(?:[^"\\]|\\.)*")$/i.exec(filter.trim());
  const path = match?.[1];
  const literal = match?.[2];
  if (!path || !literal) throw new ScimError(400, "Expected a group equality filter.", "invalidFilter");
  const fields: readonly NonNullable<ScimGroupQuery["filter"]>["attribute"][] = ["displayName", "externalId", "id"];
  const attribute = fields.find((field) => field.toLowerCase() === attributePath(path, groupSchema));
  const value = parseFilterLiteral(literal);
  if (!attribute || typeof value !== "string") throw new ScimError(400, "Unknown group filter field.", "invalidFilter");
  return { attribute, value };
}

function groupResult(result: ScimGroup | "conflict" | "invalidMember" | null): ScimGroup {
  if (!result) throw new ScimError(404, "Group not found.");
  if (result === "conflict") throw new ScimError(409, "Group conflicts with the directory.", "uniqueness");
  if (result === "invalidMember")
    throw new ScimError(400, "Group members must reference users in the directory tenant.", "invalidValue");
  return result;
}

export async function handleGroups(
  directory: ScimGroupDirectory,
  tenantId: string,
  baseUrl: string,
  request: Request,
  params: URLSearchParams,
  id: string | undefined,
): Promise<Response> {
  const project = createResourceProjection(params, groupSchema);
  const location = (group: ScimGroup) => `${baseUrl}/Groups/${encodeURIComponent(group.id)}`;
  const render = ({ id, created, lastModified, displayName, externalId, members }: ScimGroup) =>
    project(id, {
      displayName,
      externalId,
      members: members.map(({ value }) => ({
        value,
        type: "User",
        $ref: `${baseUrl}/Users/${encodeURIComponent(value)}`,
      })),
      meta: {
        resourceType: "Group",
        location: `${baseUrl}/Groups/${encodeURIComponent(id)}`,
        created,
        lastModified,
      },
    });
  const saved = (group: ScimGroup, status = 200) => scimJson(render(group), status, { Location: location(group) });
  if (id === undefined) {
    switch (request.method) {
      case "GET": {
        const page = scimPage(params);
        const filter = params.get("filter");
        const result = await directory.list(
          tenantId,
          filter === null ? page : { ...page, filter: parseGroupFilter(filter) },
        );
        return scimList(result.groups.map(render), result.totalResults, page.startIndex);
      }
      case "POST": {
        const data = parseScimGroup(await scimBody(request, groupSchema));
        return saved(groupResult(await directory.create(tenantId, data)), 201);
      }
      default:
        return methodNotAllowed("GET, POST");
    }
  }
  switch (request.method) {
    case "GET":
      return scimJson(render(groupResult(await directory.get(tenantId, id))));
    case "PUT": {
      const body = parseScimGroup(await scimBody(request, groupSchema));
      return saved(groupResult(await directory.update(tenantId, id, () => body)));
    }
    case "PATCH": {
      const change = compileGroupPatch(await scimBody(request, patchSchema));
      return saved(groupResult(await directory.update(tenantId, id, change)));
    }
    case "DELETE":
      if (!(await directory.delete(tenantId, id))) throw new ScimError(404, "Group not found.");
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    default:
      return methodNotAllowed("GET, PUT, PATCH, DELETE");
  }
}
