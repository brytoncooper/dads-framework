/** Fastify mounts domain routes under this prefix. */
export const API_MOUNT_PREFIX = "/api";

/** The HTTP methods exposed by the typed route contract. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The method and mount-relative template shared by server and client. */
export type RouteContract<Method extends HttpMethod = HttpMethod, Template extends string = string> = {
  readonly method: Method;
  readonly template: Template;
};

/** One descriptor bound to concrete URL arguments for a client request. */
export type BoundRoute<Method extends HttpMethod = HttpMethod, Template extends string = string> = RouteContract<
  Method,
  Template
> & {
  readonly path: string;
};

/** A generated binding retains the operation identifier for client diagnostics. */
export type GeneratedBoundRoute<
  Method extends HttpMethod = HttpMethod,
  Template extends string = string,
  Operation extends string = string,
> = BoundRoute<Method, Template> & {
  readonly operation: Operation;
};

/**
 * A route emitted from a typed server route card for use by API clients only.
 *
 * The server consumes neither this value nor its output. `bind` is the single
 * client seam that turns branded route arguments into a concrete request URL.
 */
export type GeneratedRoute<
  Method extends HttpMethod,
  Template extends string,
  Operation extends string,
  Arguments extends readonly unknown[],
> = RouteContract<Method, Template> & {
  readonly operation: Operation;
  bind(...arguments_: Arguments): GeneratedBoundRoute<Method, Template, Operation>;
};

/**
 * One endpoint contract: method + server template + typed client path builder.
 *
 * `bind` preserves the verb beside the concrete URL for request transports.
 * `path` is the explicit string-only form for query keys and other URL callers.
 */
export type RouteDescriptor<
  Method extends HttpMethod,
  Template extends string,
  Arguments extends readonly unknown[],
> = RouteContract<Method, Template> & {
  bind(...arguments_: Arguments): BoundRoute<Method, Template>;
  path(...arguments_: Arguments): string;
};

/** Define an endpoint once for both server registration and client requests. */
export function defineRoute<
  const Method extends HttpMethod,
  const Template extends string,
  Arguments extends readonly unknown[],
>(
  method: Method,
  template: Template,
  buildPath: (...arguments_: Arguments) => string,
): RouteDescriptor<Method, Template, Arguments> {
  return {
    method,
    template,
    bind: (...arguments_: Arguments) => ({
      method,
      template,
      path: buildPath(...arguments_),
    }),
    path: (...arguments_: Arguments) => buildPath(...arguments_),
  };
}

/**
 * Define a generated, client-only route binding from its route-card facts.
 *
 * `operation` is stable because it is derived from the same method/template
 * rule that produces OpenAPI operation IDs. Generated source supplies the
 * binding tuple, preserving branded inputs without a client-authored method.
 */
export function defineGeneratedRoute<
  const Method extends HttpMethod,
  const Template extends string,
  const Operation extends string,
  Arguments extends readonly unknown[],
>(
  method: Method,
  template: Template,
  operation: Operation,
  buildPath: (...arguments_: Arguments) => string,
): GeneratedRoute<Method, Template, Operation, Arguments> {
  return {
    method,
    template,
    operation,
    bind: (...arguments_: Arguments) => ({
      method,
      template,
      operation,
      path: buildPath(...arguments_),
    }),
  };
}

/** Client path from a mount-relative route (`/products` → `/api/products`). */
export function apiPath(mountRelativePath: string): string {
  return `${API_MOUNT_PREFIX}${mountRelativePath}`;
}
