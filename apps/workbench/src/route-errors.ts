import {
  authorizationUnavailable,
  postgresWriteConflict,
  relationshipsPending,
  resourceNotFound,
  workbenchConflict,
} from "./contracts.js";

/**
 * The failure contract every Workbench route publishes.
 *
 * `routeOutcome` translates the published application and database failures and
 * rethrows anything else, so the list belongs to the pair, not to one route. A
 * route that declared a shorter list would still be able to return a failure it
 * had not published.
 */
export const workbenchRouteErrors = [
  resourceNotFound,
  workbenchConflict,
  postgresWriteConflict,
  relationshipsPending,
  authorizationUnavailable,
];
