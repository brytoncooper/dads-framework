import type { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";
import type { AnyOperationContract, HttpMethod, RouteContract } from "@dads-framework/core/contract";

import { HttpWiringError } from "../http-errors.js";
import type { RouteAccess } from "./access.js";
import type { RouteCapabilities } from "./capabilities.js";
import type {
  ErasedNoContentVerbConfig,
  ErasedVerbConfig,
  ResourceFreePostPolicy,
  RouteHandlerContext,
} from "./route-definition.js";

/** Shared server-side fields when declaring a route from an operation contract. */
export type OperationVerbCommon<Access extends RouteAccess> = {
  /** OpenAPI operation summary. */
  readonly summary: string;
  /** Maximum request body bytes for this route; omitted retains the application limit. */
  readonly bodyLimitBytes?: number;
  readonly access: Access;
  /** Route-rung of the capability ladder (route > group > app). */
  readonly capabilities?: RouteCapabilities;
};

/** Erased list verb input (route/path inline form). */
export type ErasedListConfig = {
  readonly route?: RouteContract<"GET">;
  readonly path?: string;
  readonly summary: string;
  readonly bodyLimitBytes?: number;
  readonly access: RouteAccess;
  readonly capabilities?: RouteCapabilities;
  readonly params?: z.ZodType;
  readonly query: z.ZodType;
  readonly item: z.ZodType;
  readonly meta?: z.ZodType;
  handler(ctx: RouteHandlerContext<unknown, unknown, unknown, SubjectRef>): unknown;
};

/** Erased operation-backed input for response-producing verbs. */
export type ErasedOperationVerbConfig = OperationVerbCommon<RouteAccess> & {
  readonly operation: AnyOperationContract;
  handler(ctx: RouteHandlerContext<unknown, unknown, unknown, SubjectRef | null>): unknown;
};

/** Erased POST input with optional telemetry resource policy. */
export type ErasedPostVerbConfig = ErasedVerbConfig & {
  readonly resourcePolicy?: ResourceFreePostPolicy;
};

/** Erased operation-backed POST input with optional telemetry resource policy. */
export type ErasedOperationPostConfig = ErasedOperationVerbConfig & {
  readonly resourcePolicy?: ResourceFreePostPolicy;
};

/** Erased operation-backed input for no-content verbs (DELETE, POST 204). */
export type ErasedOperationNoContentConfig = OperationVerbCommon<RouteAccess> & {
  readonly operation: AnyOperationContract;
  handler(ctx: RouteHandlerContext<unknown, undefined, unknown, SubjectRef | null>): Promise<void> | void;
};

function hasOperation<T extends object>(config: T): config is T & { readonly operation: AnyOperationContract } {
  return "operation" in config && config.operation !== undefined;
}

function invalidOperationError(
  verb: string,
  expectedKind: AnyOperationContract["kind"],
  operation: unknown,
): HttpWiringError {
  const actualKind =
    typeof operation === "object" && operation !== null && "kind" in operation
      ? String(operation.kind)
      : typeof operation;
  return new HttpWiringError(`${verb} expected a "${expectedKind}" operation contract, received "${actualKind}"`);
}

function assertOperationShape(
  verb: string,
  expectedKind: AnyOperationContract["kind"],
  expectedMethod: HttpMethod,
  operation: unknown,
): void {
  if (typeof operation !== "object" || operation === null) {
    throw invalidOperationError(verb, expectedKind, operation);
  }
  const kind = "kind" in operation ? operation.kind : undefined;
  const method = "method" in operation ? operation.method : undefined;
  if (kind !== expectedKind || method !== expectedMethod) {
    throw invalidOperationError(verb, expectedKind, operation);
  }
}

function commonFieldsOf(config: OperationVerbCommon<RouteAccess>): {
  readonly summary: string;
  readonly access: RouteAccess;
  readonly bodyLimitBytes?: number;
  readonly capabilities?: RouteCapabilities;
} {
  return {
    summary: config.summary,
    access: config.access,
    ...(config.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: config.bodyLimitBytes }),
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
  };
}

function optionalSchemasOf(op: {
  readonly params?: z.ZodType | undefined;
  readonly query?: z.ZodType | undefined;
  readonly body?: z.ZodType | undefined;
  readonly meta?: z.ZodType | undefined;
}): {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly meta?: z.ZodType;
} {
  return {
    ...(op.params === undefined ? {} : { params: op.params }),
    ...(op.query === undefined ? {} : { query: op.query }),
    ...(op.body === undefined ? {} : { body: op.body }),
    ...(op.meta === undefined ? {} : { meta: op.meta }),
  };
}

/** Normalize a getRoute config (inline or operation-backed) into ErasedVerbConfig. */
export function resolveGetOperationConfig(config: ErasedVerbConfig | ErasedOperationVerbConfig): ErasedVerbConfig {
  if (!hasOperation(config)) return config;
  const op = config.operation;
  assertOperationShape("getRoute", "get", "GET", op);
  if (op.kind !== "get") {
    throw invalidOperationError("getRoute", "get", op);
  }
  return {
    ...commonFieldsOf(config),
    ...optionalSchemasOf(op),
    route: op,
    response: op.response,
    handler: (ctx) => config.handler(ctx),
  };
}

/** Normalize a listRoute config (inline or operation-backed) into ErasedListConfig. */
export function resolveListOperationConfig(config: ErasedListConfig | ErasedOperationVerbConfig): ErasedListConfig {
  if (!hasOperation(config)) return config;
  const op = config.operation;
  assertOperationShape("listRoute", "list", "GET", op);
  if (op.kind !== "list") {
    throw invalidOperationError("listRoute", "list", op);
  }
  return {
    ...commonFieldsOf(config),
    ...(op.params === undefined ? {} : { params: op.params }),
    ...(op.meta === undefined ? {} : { meta: op.meta }),
    route: op,
    query: op.query,
    item: op.item,
    handler: (ctx) => config.handler(ctx),
  };
}

/** Normalize a postRoute config (inline or operation-backed) into ErasedPostVerbConfig. */
export function resolvePostOperationConfig(
  config: ErasedPostVerbConfig | ErasedOperationPostConfig,
): ErasedPostVerbConfig {
  if (!hasOperation(config)) return config;
  const op = config.operation;
  assertOperationShape("postRoute", "post", "POST", op);
  if (op.kind !== "post") {
    throw invalidOperationError("postRoute", "post", op);
  }
  return {
    ...commonFieldsOf(config),
    ...optionalSchemasOf(op),
    ...(config.resourcePolicy === undefined ? {} : { resourcePolicy: config.resourcePolicy }),
    route: op,
    response: op.response,
    status: op.status,
    handler: (ctx) => config.handler(ctx),
  };
}

/** Normalize a patchRoute or putRoute config into ErasedVerbConfig. */
export function resolveMutateOperationConfig(
  config: ErasedVerbConfig | ErasedOperationVerbConfig,
  expectedKind: "patch" | "put",
): ErasedVerbConfig {
  if (!hasOperation(config)) return config;
  const verb = expectedKind === "patch" ? "patchRoute" : "putRoute";
  const method = expectedKind === "patch" ? "PATCH" : "PUT";
  const op = config.operation;
  assertOperationShape(verb, expectedKind, method, op);
  if (op.kind !== expectedKind) {
    throw invalidOperationError(verb, expectedKind, op);
  }
  return {
    ...commonFieldsOf(config),
    ...(op.params === undefined ? {} : { params: op.params }),
    route: op,
    body: op.body,
    response: op.response,
    handler: (ctx) => config.handler(ctx),
  };
}

/** Normalize a deleteRoute or postNoContentRoute config into ErasedNoContentVerbConfig. */
export function resolveNoContentOperationConfig(
  config: ErasedNoContentVerbConfig | ErasedOperationNoContentConfig,
  expectedKind: "delete" | "post-no-content",
): ErasedNoContentVerbConfig {
  if (!hasOperation(config)) return config;
  const verb = expectedKind === "delete" ? "deleteRoute" : "postNoContentRoute";
  const method = expectedKind === "delete" ? "DELETE" : "POST";
  const op = config.operation;
  assertOperationShape(verb, expectedKind, method, op);
  if (op.kind !== expectedKind) {
    throw invalidOperationError(verb, expectedKind, op);
  }
  return {
    ...commonFieldsOf(config),
    ...(op.params === undefined ? {} : { params: op.params }),
    ...(op.body === undefined ? {} : { body: op.body }),
    route: op,
    handler: (ctx) => config.handler(ctx),
  };
}
