import type { ClientEnvironmentSnapshot } from "./build-client-context.js";

/**
 * The window fields the client context reads, and nothing else. Declaring the
 * shape here rather than taking `Window` keeps a test free to pass a two-field
 * object, and keeps this module honest about how little of the browser it
 * touches. The real `Window` satisfies it.
 */
export type ClientWindowLike = {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly devicePixelRatio?: number;
  readonly screen?: { readonly width?: number; readonly height?: number };
};

/**
 * The navigator fields the client context reads. `connection` and
 * `deviceMemory` are not in the DOM types because they are not on the
 * standards track — this narrow declaration is what lets them be read without
 * an escape hatch, and optional is the truth: plenty of browsers omit them.
 */
export type ClientNavigatorLike = {
  readonly language?: string;
  readonly maxTouchPoints?: number;
  readonly onLine?: boolean;
  readonly connection?: { readonly effectiveType?: string };
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
};

/**
 * Everything the reader needs handed to it: the baked build stamp (the app
 * owns `import.meta.env`, this lib must not), the two globals, and the clock.
 */
export type ClientEnvironmentSources = {
  readonly build: string | undefined;
  readonly window: ClientWindowLike;
  readonly navigator: ClientNavigatorLike;
  readonly nowMs: number;
};

/**
 * When this tab loaded — the only thing `tabAgeMs` can be measured from.
 *
 * Stamped by the app rather than read from a module-level `Date.now()`: a
 * clock that runs at import time is one no caller can see and no test can
 * control. Until it is stamped there is no age to report, which is the honest
 * answer — not a zero that reads like a freshly opened tab.
 */
let tabStartedAtMs: number | undefined = undefined;

let currentRouteId: string | undefined = undefined;

/**
 * Record when this tab started, as the same millisecond clock the reader is
 * later handed. The app's composition root calls this once at boot; an
 * embedder that does not simply gets no `tabAgeMs`.
 */
export function markTabStarted(nowMs: number): void {
  tabStartedAtMs = nowMs;
}

/**
 * Record the route the reader is on, as the router's matched route id
 * (`/orders/$orderId`), never the pathname — the same identifier the request
 * log stores instead of a path, and for the same reason.
 *
 * The app's composition root is the one place that holds the router, so it is
 * what calls this.
 */
export function setCurrentRouteId(routeId: string | undefined): void {
  currentRouteId = routeId;
}

/**
 * Read what this tab can say about itself right now.
 *
 * Every read is guarded: a missing API, or a getter that throws on a hardened
 * browser, yields `undefined` for that one field rather than failing the
 * request that asked. Nothing here is fingerprinting — each field answers a
 * debugging question the request log is expected to be asked.
 */
export function readClientEnvironment(
  sources: ClientEnvironmentSources,
): ClientEnvironmentSnapshot {
  const { window, navigator } = sources;
  return {
    build: sources.build,
    timeZone: read(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    locale: read(() => navigator.language),
    routeId: currentRouteId,
    viewport: read(() => readViewport(window)),
    screen: read(() => readScreen(window)),
    touch: read(() => readTouch(navigator)),
    online: read(() => navigator.onLine),
    connection: read(() => navigator.connection?.effectiveType),
    deviceMemory: read(() => navigator.deviceMemory),
    hardwareConcurrency: read(() => navigator.hardwareConcurrency),
    tabAgeMs:
      tabStartedAtMs === undefined ? undefined : sources.nowMs - tabStartedAtMs,
  };
}

/** One field's read, where nothing it can do ends the request. */
function read<Value>(readValue: () => Value): Value | undefined {
  try {
    return readValue();
  } catch {
    return undefined;
  }
}

/** All three numbers or none: half a viewport says nothing worth logging. */
function readViewport(
  window: ClientWindowLike,
): ClientEnvironmentSnapshot["viewport"] {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio;
  if (w === undefined || h === undefined || dpr === undefined) return undefined;
  return { w, h, dpr };
}

function readScreen(
  window: ClientWindowLike,
): ClientEnvironmentSnapshot["screen"] {
  const w = window.screen?.width;
  const h = window.screen?.height;
  if (w === undefined || h === undefined) return undefined;
  return { w, h };
}

/** A touch screen is a device with at least one contact point. */
function readTouch(navigator: ClientNavigatorLike): boolean | undefined {
  const points = navigator.maxTouchPoints;
  return points === undefined ? undefined : points > 0;
}
