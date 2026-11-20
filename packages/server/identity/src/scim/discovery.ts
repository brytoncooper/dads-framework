import {
  configSchema,
  groupSchema,
  resourceSchema,
  schemaSchema,
  scimJson,
  scimList,
  userSchema,
} from "./protocol.js";
import { nameAttributes } from "./user-data.js";
import { maxPageSize } from "./user-query.js";

function schemaAttribute(
  name: string,
  type = "string",
  options: Record<string, unknown> = {},
) {
  return {
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...options,
  };
}

export function scimDiscovery(
  path: string,
  baseUrl: string,
  hasGroups: boolean,
): Response | null {
  const normalized = path.toLowerCase();
  if (normalized === "serviceproviderconfig")
    return serviceProviderConfig(baseUrl);
  const entries = hasGroups ? ["User", "Group"] : ["User"];
  const [collection, id] = normalized.split("/");
  if (collection === "resourcetypes") {
    if (!id)
      return scimList(entries.map((name) => resourceType(baseUrl, name)));
    const name = entries.find((entry) => id === entry.toLowerCase());
    return name ? scimJson(resourceType(baseUrl, name)) : null;
  }
  if (collection === "schemas") {
    if (!id)
      return scimList(
        entries.map((name) => resourceSchemaDescription(baseUrl, name)),
      );
    const name = entries.find((entry) => id === schemaFor(entry).toLowerCase());
    return name ? scimJson(resourceSchemaDescription(baseUrl, name)) : null;
  }
  return null;
}

function schemaFor(name: string): string {
  return name === "User" ? userSchema : groupSchema;
}

function resourceType(baseUrl: string, name: string) {
  return {
    schemas: [resourceSchema],
    id: name,
    name,
    endpoint: `/${name}s`,
    schema: schemaFor(name),
    meta: {
      resourceType: "ResourceType",
      location: `${baseUrl}/ResourceTypes/${name}`,
    },
  };
}

function resourceSchemaDescription(baseUrl: string, name: string) {
  const id = schemaFor(name);
  return {
    schemas: [schemaSchema],
    id,
    name,
    attributes: name === "User" ? userAttributes : groupAttributes,
    meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${id}` },
  };
}

function serviceProviderConfig(baseUrl: string): Response {
  return scimJson({
    schemas: [configSchema],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: maxPageSize },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A bearer credential issued for a single tenant.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  });
}

const userAttributes = [
  schemaAttribute("userName", "string", {
    required: true,
    uniqueness: "server",
  }),
  schemaAttribute("externalId", "string", { caseExact: true }),
  schemaAttribute("active", "boolean"),
  schemaAttribute("displayName"),
  schemaAttribute("name", "complex", {
    subAttributes: nameAttributes.map((name) => schemaAttribute(name)),
  }),
  schemaAttribute("emails", "complex", {
    multiValued: true,
    subAttributes: [
      schemaAttribute("value"),
      schemaAttribute("type"),
      schemaAttribute("display"),
      schemaAttribute("primary", "boolean"),
    ],
  }),
];

const groupAttributes = [
  schemaAttribute("displayName", "string", { required: true }),
  schemaAttribute("externalId", "string", { caseExact: true }),
  schemaAttribute("members", "complex", {
    multiValued: true,
    subAttributes: [
      schemaAttribute("value", "string", {
        caseExact: true,
        mutability: "immutable",
      }),
      schemaAttribute("$ref", "reference", {
        mutability: "immutable",
        referenceTypes: ["User"],
      }),
      schemaAttribute("type", "string", {
        mutability: "immutable",
        canonicalValues: ["User"],
      }),
    ],
  }),
];
