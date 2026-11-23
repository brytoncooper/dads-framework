import { z } from "zod";

import { apiResponseSchema, openExtensibleEnums } from "@dads-framework/core/contract";

import { isObjectValue } from "../object-value.js";
import type { RawRouteDefinition } from "../route/define-raw-route.js";
import type { RouteDefinition } from "../route/route-definition.js";
import { capitalizeInitial } from "./logic/capitalize-initial.js";
import { schemaComponents } from "./logic/schema-components.js";

/**
 * OpenAPI generated from the route table — never hand-written (ADR-0006,
 * docs/architecture/api-documentation.md). Schemas convert via Zod 4's
 * native `z.toJSONSchema` targeting OpenAPI 3.0 (matching the committed
 * artifact's dialect); the enveloped response components are built with the
 * same `apiResponseSchema` the contract libs use, so the document cannot
 * drift from the wire truth.
 */

export type OpenApiTag = {
  readonly name: string;
  readonly description: string;
};

export type OpenApiDocumentMeta = {
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly tags: readonly OpenApiTag[];
  /** Prepended to every route path (the app's global prefix), e.g. "/api". */
  readonly pathPrefix: string;
};

type JsonRecord = Record<string, unknown>;

/** `:param` segments become `{param}` per the OpenAPI path template syntax. */
function toOpenApiPath(prefix: string, routePath: string): string {
  const templated = routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  // The root route ("/") documents as the prefix itself, never "/prefix/".
  return templated === "/" ? prefix : `${prefix}${templated}`;
}

/**
 * Deterministic, readable operation id: method + path segments, params as
 * "By<Name>" — `GET /organizations/:id` → `getOrganizationsById`.
 */
function operationIdFor(route: { method: string; path: string }): string {
  const segments = route.path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.startsWith(":")
        ? `By${capitalizeInitial(segment.slice(1))}`
        : segment.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : "")),
    )
    .map(capitalizeInitial);
  return route.method.toLowerCase() + segments.join("");
}

function toSchemaObject(schema: z.ZodType, io: "input" | "output"): JsonRecord {
  const converted: unknown = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io,
    // Unrepresentable pieces (e.g. transforms) degrade to {} instead of
    // throwing — the artifact diff review catches anything surprising.
    unrepresentable: "any",
    override: openExtensibleEnums,
  });
  return isObjectValue(converted) ? converted : {};
}

/** The route's success component: `{ data, meta? }`, enveloped exactly once. */
function envelopedResponseSchema(response: z.ZodType, meta: z.ZodType | undefined): z.ZodType {
  if (meta) {
    // Same field descriptions apiResponseSchema carries — the artifact's
    // documentation walls (spectral) hold for list envelopes too.
    return z.object({
      data: response.meta({ description: "The requested resource" }),
      meta: meta.meta({
        description: "Response metadata only (totals, cursors, warnings) — never business data",
      }),
    });
  }
  return apiResponseSchema(response);
}

function responsesFor(route: RouteDefinition, components: Map<string, JsonRecord>, responseName: string): JsonRecord {
  if (!route.schemas.response) {
    return { [String(route.status)]: { description: "" } };
  }
  components.set(
    responseName,
    toSchemaObject(envelopedResponseSchema(route.schemas.response, route.schemas.meta), "output"),
  );
  return {
    [String(route.status)]: {
      description: "",
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${responseName}` },
        },
      },
    },
  };
}

type ParameterObject = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: unknown;
  description?: string;
};

/** Explodes an object schema into per-property OpenAPI parameters. */
function parametersFrom(schema: z.ZodType | undefined, location: "path" | "query"): ParameterObject[] {
  if (!schema) return [];
  const json = toSchemaObject(schema, "input");
  const properties = isObjectValue(json["properties"]) ? json["properties"] : {};
  const required = Array.isArray(json["required"]) ? json["required"] : [];
  return Object.entries(properties).map(([name, propSchema]) => {
    const description =
      isObjectValue(propSchema) && typeof propSchema["description"] === "string"
        ? { description: propSchema["description"] }
        : {};
    return {
      name,
      in: location,
      required: location === "path" ? true : required.includes(name),
      schema: propSchema,
      ...description,
    };
  });
}

function requestBodyFor(
  route: RouteDefinition,
  componentName: string,
  components: Map<string, JsonRecord>,
): JsonRecord | undefined {
  if (!route.schemas.body) return undefined;
  components.set(componentName, toSchemaObject(route.schemas.body, "input"));
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${componentName}` },
      },
    },
  };
}

function contextHeaderParameters(route: RouteDefinition): ParameterObject[] {
  if (route.access.kind === "session" && route.access.authorizationContextInput?.kind === "header") {
    return [
      {
        name: route.access.authorizationContextInput.name.toLowerCase(),
        in: "header",
        required: false,
        schema: { type: "string", minLength: 1 },
        description:
          "Untrusted context input for operation-owned runtime authorization; the operation determines whether its selected authority requires this input",
      },
    ];
  }
  if (route.access.kind === "public" || route.access.authorizationContext?.kind !== "header") return [];
  return [
    {
      name: route.access.authorizationContext.name.toLowerCase(),
      in: "header",
      required: route.access.authorizationContextMode !== "technical-or-business",
      schema: { type: "string", minLength: 1 },
      description:
        route.access.authorizationContextMode === "technical-or-business"
          ? "Omission selects authenticated technical identity; a supplied business context must resolve and never falls back to technical identity"
          : "Single request context identifier; authenticated identity is resolved server-side",
    },
  ];
}

function operationFor(route: RouteDefinition, components: Map<string, JsonRecord>): JsonRecord {
  const operationId = operationIdFor(route);
  const requestBody = requestBodyFor(route, `${capitalizeInitial(operationId)}Body`, components);
  return {
    operationId,
    summary: route.summary,
    tags: [route.tag],
    parameters: [
      ...parametersFrom(route.schemas.params, "path"),
      ...parametersFrom(route.schemas.query, "query"),
      ...contextHeaderParameters(route),
    ],
    ...(requestBody ? { requestBody } : {}),
    responses: responsesFor(route, components, `${capitalizeInitial(operationId)}Response`),
  };
}

/**
 * A raw route's hand-declared operation, visibly marked in the artifact. Its
 * declared component schemas are registered here — the operation's `$ref`s
 * would dangle otherwise, since no typed verb registers them.
 */
function rawOperationFor(route: RawRouteDefinition, components: Map<string, JsonRecord>): JsonRecord {
  for (const [name, schema] of Object.entries(route.openapiComponents ?? {})) {
    components.set(name, toSchemaObject(schema, "output"));
  }
  return {
    ...route.openapi,
    operationId: operationIdFor(route),
    summary: route.summary,
    tags: [route.tag],
    "x-raw-route": true,
  };
}

/** Builds the full OpenAPI 3.0 document from a route table. */
export function buildOpenApiDocument(
  routes: readonly (RouteDefinition | RawRouteDefinition)[],
  meta: OpenApiDocumentMeta,
): JsonRecord {
  const components = new Map<string, JsonRecord>();
  const paths: Record<string, JsonRecord> = {};
  for (const route of routes) {
    const path = toOpenApiPath(meta.pathPrefix, route.path);
    paths[path] = {
      ...paths[path],
      [route.method.toLowerCase()]:
        route.kind === "raw-route" ? rawOperationFor(route, components) : operationFor(route, components),
    };
  }
  return {
    openapi: "3.0.0",
    info: {
      title: meta.title,
      description: meta.description,
      version: meta.version,
      contact: {},
    },
    tags: meta.tags.map((tag) => ({
      name: tag.name,
      description: tag.description,
    })),
    paths,
    components: { schemas: schemaComponents(components) },
  };
}
