export {
  callApi,
  createApiClient,
  type ApiClient,
  type ApiDataWithMeta,
  type CallApiOptions,
  type OperationCallArgs,
  type OperationCallInput,
  type OperationCallPromise,
  type OperationCallResult,
  type OperationClientMethod,
  type OperationRecord,
} from "./lib/call-api.js";
export {
  getFromApi,
  getPageFromApi,
  getPageWithMetaFromApi,
  requestBinary,
  sendToApi,
  sendToApiWithoutResponse,
  type ApiArgument,
  type ApiPage,
  type ApiPageWithMeta,
  type ApiQueryArgument,
  type BinaryRequest,
} from "./lib/api-verbs.js";
export {
  ApiError,
  NetworkError,
  UnauthorizedError,
  readClientFailure,
  type ClientFailure,
} from "./lib/api-error.js";
export {
  onUnauthorizedResponse,
  type UnauthorizedResponseListener,
} from "./lib/unauthorized-response-channel.js";
export {
  onApiExchange,
  type ApiExchange,
  type ApiExchangeListener,
} from "./lib/api-exchange-channel.js";
export {
  currentRequestLocale,
  setRequestLocale,
} from "./lib/request-locale.js";
export {
  putToSignedUrl,
  SignedUploadRefusedError,
} from "./lib/signed-url-upload.js";
export { setClientContextProvider } from "./lib/client-context.js";
export {
  buildClientContext,
  type ClientEnvironmentSnapshot,
} from "./lib/build-client-context.js";
export {
  markTabStarted,
  readClientEnvironment,
  setCurrentRouteId,
  type ClientEnvironmentSources,
  type ClientNavigatorLike,
  type ClientWindowLike,
} from "./lib/read-client-environment.js";
export {
  registerRequestMetadata,
  type ApiResponseObserver,
  type RequestMetadataProvider,
} from "./lib/request-metadata.js";
export type { HttpMethod, ApiRequestHeaders } from "./lib/send-api-request.js";
export {
  FAILURE_PRESENTED_INLINE,
  isFailurePresentedInline,
  type FailurePresentationMeta,
} from "./lib/failure-presentation.js";
export {
  applyRecordEffect,
  optimisticRecordWrite,
  optimisticRecordWriteWithoutInput,
  type OptimisticQueryCache,
  type OptimisticRecordEffect,
  type OptimisticRecordWriteOptions,
  type OptimisticSnapshot,
} from "./lib/optimistic-cache.js";
export {
  saveWithRefresh,
  type SaveWithRefreshResult,
} from "./lib/save-with-refresh.js";
