import { resolveCapabilities, type RouteCapabilities } from "./capabilities.js";
import type { RawRouteBlueprint, RawRouteDefinition } from "./define-raw-route.js";
import type { RouteBlueprint, RouteDefinition } from "./route-definition.js";

/**
 * The only door from authored routes to registrable ones (always-a-group
 * rule, locked with Bryton 2026-07-09): the OpenAPI tag is stamped ONCE per
 * group, and group-level capabilities apply across every member — each
 * route's own `capabilities` field overrides per key (route > group; the
 * app default merges at registration).
 *
 * Groups compose: a domain owning two tags returns
 * `[...groupA, ...groupB]`. A blueprint that never passed through a group
 * is not a `RouteDefinition` and will not register — forgetting the group
 * is a compile error, not a runtime surprise.
 */

export type HttpRoute = RouteDefinition | RawRouteDefinition;
type AnyBlueprint = RouteBlueprint | RawRouteBlueprint;

function isBlueprintList(value: RouteCapabilities | readonly AnyBlueprint[]): value is readonly AnyBlueprint[] {
  return Array.isArray(value);
}

export function routeGroup(tag: string, routes: readonly AnyBlueprint[]): HttpRoute[];
export function routeGroup(tag: string, capabilities: RouteCapabilities, routes: readonly AnyBlueprint[]): HttpRoute[];
export function routeGroup(
  tag: string,
  capabilitiesOrRoutes: RouteCapabilities | readonly AnyBlueprint[],
  maybeRoutes?: readonly AnyBlueprint[],
): HttpRoute[] {
  const capabilities = isBlueprintList(capabilitiesOrRoutes) ? undefined : capabilitiesOrRoutes;
  const routes = isBlueprintList(capabilitiesOrRoutes) ? capabilitiesOrRoutes : (maybeRoutes ?? []);
  return routes.map((blueprint) => ({
    ...blueprint,
    tag,
    capabilities: resolveCapabilities(undefined, capabilities, blueprint.capabilities),
  }));
}
