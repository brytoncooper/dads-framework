/**
 * Route capabilities — the kit's answer to middleware (design locked with
 * Bryton, 2026-07-09): NAMED, TYPED fields instead of anonymous hook
 * chains. Every capability is declared data, visible on the route, resolved
 * through a three-rung ladder:
 *
 *   route field  >  group capabilities  >  app default (registerRoutes)
 *
 * "What applies to this route" is answerable by reading at most three named
 * places. Capabilities grow here BY NEED, each with an engine and tests in
 * the kit — never as user-supplied functions.
 */

export type RateLimitCapability =
  | {
      /** Requests allowed per minute for one caller (subject id, else ip). */
      readonly perMinute: number;
    }
  | "unlimited";

/**
 * What a plant-side copy of the API does with this route. Set only by a
 * applications that run a second deployment of the API.
 *   served      the site answers it itself
 *   write_door  the site applies the change locally and sends it to the cloud
 *   cloud_only  the cloud owns it. The site refuses a cloud_only read or
 *               write with 409 after its access check (unless the site build
 *               drops the route, which then answers 404); a cloud_only GET is
 *               never answered from the site's own copy
 */
export type SiteServing = "served" | "write_door" | "cloud_only";

/**
 * Why a site never answers a `cloud_only` route. The same idea as a table
 * sync label's cloud-only `reason`, in the words a route needs:
 *   STAFF_TOOLS     an application staff tool
 *   COMPANY_DESK    company-wide setup done from the office, not a plant's
 *                   shift work
 *   NEEDS_INTERNET  talks to an outside service (email, SSO, payments,
 *                   storage), so a site cannot answer it offline
 *   FLEET           the cloud's end of a link to sites and devices
 *                   (enrollment, check-in, the sync feed, releases)
 *   NOT_YET         should work at a site; `ticket` names the work
 */
export type CloudOnlyRouteReason =
  "STAFF_TOOLS" | "COMPANY_DESK" | "NEEDS_INTERNET" | "FLEET" | "NOT_YET";

/**
 * The reason on a `cloud_only` label: one closed `reason` plus one plain
 * sentence a reviewer can read. `NOT_YET` names the ticket that will make
 * the route work at a site, so that backlog is one catalog query.
 */
export type CloudOnlyRouteLabel =
  | {
      readonly reason: Exclude<CloudOnlyRouteReason, "NOT_YET">;
      readonly why: string;
      readonly ticket?: never;
    }
  | {
      readonly reason: "NOT_YET";
      readonly why: string;
      readonly ticket: `${string}-${number}`;
    };

export type RouteCapabilities = {
  /**
   * Per-caller request budget, enforced after access (a denied caller never
   * consumes budget knowledge). Per-replica accounting — a distributed
   * limiter is a deliberate upgrade when multi-instance deploys arrive.
   */
  readonly rateLimit?: RateLimitCapability;
  /** Reject a stale client feature-state hash before this flag-dependent write runs. */
  readonly featureStateWrite?: "sensitive";
  /**
   * Let this write run while the caller's feature preview refuses writes —
   * for the routes that start, change and end the preview itself.
   */
  readonly writesDuringFeaturePreview?: "allowed";
  /**
   * The named machine credential this route accepts INSTEAD of user
   * sessions: its caller resolves only through
   * `registerRoutes({ machineCredentials })[name]`, never through the
   * session resolver. Resolved from the route or its group only — the app rung never
   * supplies it (registration throws). A route without it never sees
   * machine credentials.
   */
  readonly machineCredential?: string;
  /**
   * What a site server does with this route. Resolved from the route or its
   * group only; the app rung never supplies it (registration throws). The kit
   * only carries it; no default, so `undefined` means "not labelled".
   */
  readonly site?: SiteServing;
  /**
   * Why a `cloud_only` route stays in the cloud. It travels with `site`: a
   * route that overrides its group's label never inherits the group's
   * reason, and a route may give its own reason under its group's label.
   * The app rung never supplies it (registration throws). The product
   * decides whether it is required.
   */
  readonly cloudOnly?: CloudOnlyRouteLabel;
};

/**
 * route > group > app, field by field, except `cloudOnly`: when a more
 * specific rung than the reason's overrides `site` with another label, the
 * reason explains a label the route no longer has, so it is dropped. A rung
 * that repeats `cloud_only` keeps the reason.
 */
export function resolveCapabilities(
  app: RouteCapabilities | undefined,
  group: RouteCapabilities | undefined,
  route: RouteCapabilities | undefined,
): RouteCapabilities {
  const merged: RouteCapabilities = { ...app, ...group, ...route };
  const rungs = [app, group, route];
  const siteRung = lastRungSetting(rungs, (rung) => rung.site !== undefined);
  const reasonRung = lastRungSetting(
    rungs,
    (rung) => rung.cloudOnly !== undefined,
  );
  const labelOverridden = reasonRung < siteRung && merged.site !== "cloud_only";
  return labelOverridden ? withoutCloudOnlyLabel(merged) : merged;
}

/** The capabilities with the cloud-only reason removed, not set to undefined. */
function withoutCloudOnlyLabel(
  capabilities: RouteCapabilities,
): RouteCapabilities {
  const copy = { ...capabilities };
  delete copy.cloudOnly;
  return copy;
}

/** The index of the most specific rung for which `sets` holds; -1 for none. */
function lastRungSetting(
  rungs: readonly (RouteCapabilities | undefined)[],
  sets: (rung: RouteCapabilities) => boolean,
): number {
  let found = -1;
  rungs.forEach((rung, index) => {
    if (rung !== undefined && sets(rung)) found = index;
  });
  return found;
}
