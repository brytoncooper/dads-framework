import {
  effectiveFeatureStateSchema,
  FEATURE_FLAG_HISTORY_PATH,
  FEATURE_FLAGS_PATH,
  FEATURE_STATE_PATH,
  featureFlagHistoryEntrySchema,
  featureFlagHistoryParamsSchema,
  featureFlagHistoryQuerySchema,
  featureFlagManagementListSchema,
  type FeatureFlags,
  PUBLIC_FEATURE_STATE_PATH,
  publicFeatureStateSchema,
  updateFeatureFlagsRequestSchema,
  updateFeatureFlagsResponseSchema,
} from "../index.js";
import {
  getRoute,
  type HttpRoute,
  listRoute,
  type PermissionAccess,
  postRoute,
  publicAccess,
  requireSession,
  type RouteBlueprint,
  routeGroup,
} from "@dads-framework/http";

export type FeatureFlagRoutesOptions = {
  readonly featureFlags: FeatureFlags;
  /**
   * Who may list, read history of and change flags. The application names
   * the permission and resource; the HTTP kit asks the application's
   * `Authorization` before any handler runs, and a refusal is a plain 404.
   */
  readonly manage: PermissionAccess;
  /** OpenAPI tag for the group; defaults to "Feature flags". */
  readonly tag?: string;
};

/** Management, effective-state and public-state routes for one composed set of flags. */
export function createFeatureFlagRoutes(options: FeatureFlagRoutesOptions): HttpRoute[] {
  return routeGroup(options.tag ?? "Feature flags", [
    ...managementRoutes(options),
    ...stateRoutes(options.featureFlags),
  ]);
}

function managementRoutes(options: FeatureFlagRoutesOptions): RouteBlueprint[] {
  const { featureFlags, manage } = options;
  return [
    getRoute({
      path: FEATURE_FLAGS_PATH,
      summary: "List feature flags with their audiences",
      access: manage,
      response: featureFlagManagementListSchema,
      handler: () => featureFlags.management.execute(),
    }),
    listRoute({
      path: FEATURE_FLAG_HISTORY_PATH,
      summary: "List one feature flag's change history, newest first",
      access: manage,
      params: featureFlagHistoryParamsSchema,
      query: featureFlagHistoryQuerySchema,
      item: featureFlagHistoryEntrySchema,
      handler: ({ params, query }) =>
        featureFlags.history.execute({
          slug: params.slug,
          page: query.page,
          perPage: query.perPage,
        }),
    }),
    postRoute({
      path: FEATURE_FLAGS_PATH,
      summary: "Change feature flag audiences together or not at all",
      access: manage,
      body: updateFeatureFlagsRequestSchema,
      response: updateFeatureFlagsResponseSchema,
      status: 200,
      handler: async ({ body, authenticatedSubject }) => ({
        states: [
          ...(await featureFlags.update.execute({
            request: body,
            actorId: authenticatedSubject.id,
          })),
        ],
      }),
    }),
  ];
}

function stateRoutes(featureFlags: FeatureFlags): RouteBlueprint[] {
  return [
    getRoute({
      path: FEATURE_STATE_PATH,
      summary: "Read the caller's effective feature allow-list",
      access: requireSession(),
      response: effectiveFeatureStateSchema,
      // A session whose context resolves to nothing reads the platform answer.
      handler: async ({ featureState }) => featureState ?? (await featureFlags.effective.execute({ kind: "platform" })),
    }),
    publicStateRoute(featureFlags),
  ];
}

export function createPublicFeatureFlagRoutes(featureFlags: FeatureFlags, tag = "Feature flags"): HttpRoute[] {
  return routeGroup(tag, [publicStateRoute(featureFlags)]);
}

function publicStateRoute(featureFlags: FeatureFlags): RouteBlueprint {
  return getRoute({
    path: PUBLIC_FEATURE_STATE_PATH,
    summary: "Read which public-list flags are on for everyone",
    // Public by design: a signed-out page can ship dark behind a flag. The
    // query answers only for the declared public list, as the platform.
    access: publicAccess(),
    response: publicFeatureStateSchema,
    handler: () => featureFlags.publicState.execute(),
  });
}
