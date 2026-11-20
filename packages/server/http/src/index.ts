export { createHttpApp, type HttpAppOptions } from "./lib/create-http-app.js";
export {
  HandlerTimeoutError,
  HttpWiringError,
  RequestValidationError,
  ResponseDriftError,
  ServiceUnavailableError,
  type RequestPart,
} from "./lib/http-errors.js";
export {
  buildOpenApiDocument,
  type OpenApiDocumentMeta,
  type OpenApiTag,
} from "./lib/openapi/build-document.js";
export { addDiscriminators } from "./lib/openapi/logic/add-discriminators.js";
export { withListsInNameOrder } from "./lib/openapi/logic/list-order.js";
export {
  bundleOpenApiParts,
  openApiPartFileName,
  SHARED_OPENAPI_PART,
  splitOpenApiDocument,
} from "./lib/openapi/logic/openapi-parts.js";
export {
  bundleRouteCatalogParts,
  compareCatalogRoutes,
  splitRouteCatalog,
} from "./lib/route-catalog/route-catalog-parts.js";
export { openResponseObjects } from "./lib/openapi/logic/open-response-objects.js";
export type { AuditActorForSubject } from "./lib/request-pipeline/carry-audit-actor.js";
export { enforceAccess } from "./lib/request-pipeline/enforce-access.js";
export type {
  AccessDecision,
  AccessDenial,
  AccessPorts,
  AuthorizationContextResolver,
  PermissionChecker,
  SubjectResolver,
  VisibleResourceLookup,
} from "./lib/request-pipeline/enforce-access.js";
export { envelope } from "./lib/request-pipeline/envelope.js";
export type { DataEnvelope } from "./lib/request-pipeline/envelope.js";
export { installErrorHandling } from "./lib/request-pipeline/error-handler.js";
export { RequestLogSink } from "./lib/request-log/request-log-sink.js";
export { buildRequestRecord } from "./lib/request-log/request-record.js";
export type {
  RequestAccessFacts,
  RequestDecision,
  RequestRecord,
  RequestRecordInput,
} from "./lib/request-log/request-record.js";
export { requestOriginOr } from "./lib/request-pipeline/request-origin.js";
export { registerRoutes } from "./lib/request-pipeline/register-routes.js";
export type { RegisterRoutesOptions } from "./lib/request-pipeline/register-routes.js";
export type {
  FeatureStateProtocol,
  FeatureStateRequestEvaluator,
  FeatureStateSnapshot,
} from "./lib/request-pipeline/feature-state.js";
export {
  currentFeatureStatePreview,
  type FeatureStatePreview,
  type FeatureStatePreviewProtocol,
  type FeatureStatePreviewResolver,
} from "./lib/request-pipeline/feature-state-preview.js";
export {
  requestIdOf,
  requestIdSchema,
  resolveRequestId,
} from "./lib/request-pipeline/request-id.js";
export type { RequestId } from "./lib/request-pipeline/request-id.js";
export {
  DEFAULT_REQUEST_LOCALE,
  requestLocaleOf,
  resolveRequestLocale,
} from "./lib/request-pipeline/request-locale.js";
export { withDeadline } from "./lib/request-pipeline/with-deadline.js";
export {
  fromBody,
  fromFixed,
  fromHeader,
  fromParam,
  fromQuery,
  withAuthorizationContext,
  withAuthorizationContextInput,
  withTechnicalOrBusinessAuthorizationContext,
  publicAccess,
  requireSession,
  type PermissionAccess,
  type PublicAccess,
  type ResourceIdSource,
  type RouteAccess,
  type ScopedAccess,
  type SessionAccess,
  type VisibilityAccess,
  requires,
  requiresScoped,
  requiresVisible,
} from "./lib/route/access.js";
export {
  type CloudOnlyRouteLabel,
  type CloudOnlyRouteReason,
  resolveCapabilities,
  type RateLimitCapability,
  type RouteCapabilities,
  type SiteServing,
} from "./lib/route/capabilities.js";
export {
  createRateLimiter,
  type RateLimiter,
  type RateVerdict,
} from "./lib/request-pipeline/rate-limit.js";
export { contentTypeSentWithBytes } from "./lib/request-pipeline/raw-route-byte-body.js";
export { defineRawRoute } from "./lib/route/define-raw-route.js";
export type {
  RawOpenApiOperation,
  RawRouteBlueprint,
  RawRouteConfig,
  RawRouteContext,
  RawRouteDefinition,
} from "./lib/route/define-raw-route.js";
export { deleteRoute } from "./lib/route/delete-route.js";
export type {
  DeleteRouteConfig,
  DeleteRouteHandlerContext,
} from "./lib/route/delete-route.js";
export { getRoute } from "./lib/route/get-route.js";
export type {
  GetRouteConfig,
  GetRouteHandlerContext,
  GetRouteHandlerResult,
} from "./lib/route/get-route.js";
export { listRoute } from "./lib/route/list-route.js";
export type {
  ListResult,
  ListRouteConfig,
  ListRouteHandlerContext,
  ListRouteHandlerResult,
} from "./lib/route/list-route.js";
export { mapListResult } from "./lib/route/list-result.js";
export type { ListPage } from "./lib/route/list-result.js";
export { patchRoute, putRoute } from "./lib/route/patch-route.js";
export type {
  MutateRouteConfig,
  MutateRouteHandlerContext,
  MutateRouteHandlerResult,
} from "./lib/route/patch-route.js";
export { postNoContentRoute } from "./lib/route/post-no-content-route.js";
export type { PostNoContentRouteConfig } from "./lib/route/post-no-content-route.js";
export type { ResourceFreePostPolicy } from "./lib/route/route-definition.js";
export { postRoute } from "./lib/route/post-route.js";
export type {
  PostRouteConfig,
  PostRouteHandlerContext,
  PostRouteHandlerResult,
} from "./lib/route/post-route.js";
export {
  type HandlerResult,
  type AsyncNamedRouteHandler,
  type HttpMethod,
  type NamedRouteHandler,
  type PathParamNames,
  type PathParamsShape,
  type RawRouteInput,
  type RouteBlueprint,
  type RouteDefinition,
  type RouteHandlerContext,
  type RouteLogger,
  type RouteResult,
  type SchemaOutput,
} from "./lib/route/route-definition.js";
export { routeGroup } from "./lib/route/route-group.js";
export type { HttpRoute } from "./lib/route/route-group.js";
export { DEFAULT_SSE_HEARTBEAT_MS, sseRoute } from "./lib/route/sse-route.js";
export {
  acceptWebSocketUpgrades,
  type WebSocketConnection,
  type WebSocketRouteConfig,
  type WebSocketRouteContext,
  webSocketRoute,
} from "./lib/route/web-socket-route.js";
export type {
  SseCleanup,
  SseRouteConfig,
  SseRouteContext,
  SseStream,
} from "./lib/route/sse-route.js";
export * from "./lib/mcp/mcp-tool.js";

export type { RequestTrace } from "./lib/request-pipeline/request-trace.js";
