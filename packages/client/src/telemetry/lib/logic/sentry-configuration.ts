/**
 * Every promise the vendor integration makes, as one value you can read.
 *
 * Session Replay records what was on the user's screen. That is the most
 * useful thing this initiative can produce and the most dangerous thing it
 * can leak, and the difference is entirely in these defaults. So they are
 * computed by a pure function with their own tests rather than typed into an
 * `init` call, where a wrong one is invisible until somebody watches a replay
 * of a customer's order and reads their prices back.
 *
 * The masking is deliberately not per-call overridable. There is no options
 * argument that can loosen it — a caller can choose whether to record at all,
 * never what gets recorded (INV-CLIENT-TELEMETRY-4).
 *
 * The shape is Sentry's, but nothing here imports Sentry: it is a plain
 * object, so the test that guards these promises runs without the SDK and
 * keeps running if the SDK is swapped for something that accepts the same
 * envelope protocol.
 */

/** What the app knows that the configuration cannot work out for itself. */
export type SentryConfigurationInput = {
  readonly dsn: string;
  /** The build stamp. Without it a stack trace cannot find its source map. */
  readonly release: string;
  /** `production`, `staging`, a developer's machine. */
  readonly environment: string;
  /** Same-origin path the API tunnels envelopes through. */
  readonly tunnel: string;
};

export type SentryReplayMasking = {
  readonly maskAllText: true;
  readonly maskAllInputs: true;
  readonly blockAllMedia: true;
  readonly networkDetailAllowUrls: readonly [];
  readonly networkCaptureBodies: false;
};

/**
 * What the SDK is allowed to collect, category by category.
 *
 * Spelled out rather than left to defaults because the defaults are the wrong
 * way round for us: the SDK collects cookies, request and response headers,
 * every body type and query parameters unless told otherwise. Each `false`
 * below is a category of somebody's data that does not leave the tab.
 */
export type SentryDataCollection = {
  readonly userInfo: false;
  readonly cookies: false;
  readonly httpHeaders: { readonly request: false; readonly response: false };
  readonly httpBodies: readonly [];
  readonly urlQueryParams: false;
};

export type SentryConfiguration = {
  readonly dsn: string;
  readonly release: string;
  readonly environment: string;
  readonly tunnel: string;
  readonly dataCollection: SentryDataCollection;
  readonly replaysSessionSampleRate: 0;
  readonly replaysOnErrorSampleRate: 1;
  readonly tracesSampleRate: 0;
  readonly replayMasking: SentryReplayMasking;
};

/**
 * Masking that cannot be turned down.
 *
 * Every text node, every input, every image and video is replaced before the
 * recording leaves the tab, and no request or response body is captured at
 * all. What survives is layout, timing, and where the pointer went — enough
 * to see the shape of what somebody did, which is the question a replay is
 * for. Reading their data back is not.
 */
const REPLAY_MASKING: SentryReplayMasking = {
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
  // Empty, not absent: the allow-list exists and names nothing, so a URL is
  // never detailed by default the way it would be if this were omitted.
  networkDetailAllowUrls: [],
  networkCaptureBodies: false,
};

/** No user, no cookies, no headers, no bodies, no query strings. */
const DATA_COLLECTION: SentryDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
};

export function sentryConfiguration(
  input: SentryConfigurationInput,
): SentryConfiguration {
  return {
    dsn: input.dsn,
    release: input.release,
    environment: input.environment,
    // Same-origin, so there is no CORS preflight and nothing for an ad
    // blocker to recognise. A third of real users block the vendor's own
    // ingest host, and a fault channel that silently loses a third of its
    // reports is worse than one you know is off.
    tunnel: input.tunnel,
    // Who the user is comes from the session the server already resolved.
    // The browser never asserts an identity, so the vendor never stores one
    // it was handed rather than one that was verified — and nothing else the
    // SDK would collect by default leaves the tab either.
    dataCollection: DATA_COLLECTION,
    // Never record a session just because it happened. Only the ones that
    // broke, and all of those — a replay you did not keep is a bug you cannot
    // see, and a replay of a session that went fine is a recording of
    // somebody's work for no reason.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    // Tracing is OpenTelemetry's job, exported over OTLP from the
    // API. Turning it on here too would bill for and duplicate a span tree we
    // already own, and would tie the swap point to this vendor.
    tracesSampleRate: 0,
    replayMasking: REPLAY_MASKING,
  };
}
