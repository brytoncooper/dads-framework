import { HttpWiringError } from "../http-errors.js";
import type { RouteCapabilities } from "../route/capabilities.js";

/**
 * A site label is declared by a route or its group, never app-wide: an app
 * default would label every route at once and defeat the product's check
 * that each route says whether a secondary deployment may serve it.
 */
export function assertNoAppSiteServing(
  capabilities: RouteCapabilities | undefined,
): void {
  if (capabilities?.site !== undefined) {
    throw new HttpWiringError(
      "registerRoutes capabilities.site is not allowed — a route's site label is declared by the route or its group, never app-wide",
    );
  }
  if (capabilities?.cloudOnly !== undefined) {
    throw new HttpWiringError(
      "registerRoutes capabilities.cloudOnly is not allowed — a cloud-only reason is declared with its site label, by the route or its group, never app-wide",
    );
  }
}
