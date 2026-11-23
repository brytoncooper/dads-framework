import type { ClientContext } from "@dads-framework/core/contract";

/**
 * What one browser tab can say about itself, before any of it is shaped for
 * the wire. Every field is optional because every read behind it can be
 * missing: an older browser, a headless runtime, a `navigator` without the
 * non-standard extras.
 *
 * Reading the values is `read-client-environment.ts`'s job; turning them into
 * a valid {@link ClientContext} is this module's, which is why this type is a
 * plain snapshot with no globals in it.
 */
export type ClientEnvironmentSnapshot = {
  readonly build: string | undefined;
  readonly timeZone: string | undefined;
  readonly locale: string | undefined;
  readonly routeId: string | undefined;
  readonly viewport: { readonly w: number; readonly h: number; readonly dpr: number } | undefined;
  readonly screen: { readonly w: number; readonly h: number } | undefined;
  readonly touch: boolean | undefined;
  readonly online: boolean | undefined;
  readonly connection: string | undefined;
  readonly deviceMemory: number | undefined;
  readonly hardwareConcurrency: number | undefined;
  readonly tabAgeMs: number | undefined;
};

/**
 * What a required field says when the browser would not say anything. The
 * contract needs `build`, `timeZone`, and `locale` present, and "unknown" is
 * more honest in a log than an empty string that reads like a bug.
 */
const UNKNOWN = "unknown";

const MAX_BUILD = 128;
const MAX_TIME_ZONE = 64;
const MAX_LOCALE = 32;
const MAX_ROUTE_ID = 256;
const MAX_CONNECTION = 32;

/**
 * Shape one browser snapshot into the `x-client-context` payload.
 *
 * Pure, and deliberately forgiving: it clamps every string to the contract's
 * length and rounds every count to a whole number so the server's strict
 * schema accepts the result. The server drops the whole context on the first
 * violation (`decodeClientContext` returns `null`), so one absurd `routeId`
 * must not take the build stamp down with it. Absent fields stay `undefined`
 * and disappear when the context is serialized for the header.
 */
export function buildClientContext(environment: ClientEnvironmentSnapshot): ClientContext {
  return {
    version: 1,
    client: "web",
    build: text(environment.build, MAX_BUILD) ?? UNKNOWN,
    timeZone: text(environment.timeZone, MAX_TIME_ZONE) ?? UNKNOWN,
    locale: text(environment.locale, MAX_LOCALE) ?? UNKNOWN,
    routeId: text(environment.routeId, MAX_ROUTE_ID),
    viewport: viewportOf(environment.viewport),
    screen: screenOf(environment.screen),
    touch: environment.touch,
    online: environment.online,
    connection: text(environment.connection, MAX_CONNECTION),
    deviceMemory: finite(environment.deviceMemory),
    hardwareConcurrency: count(environment.hardwareConcurrency),
    tabAgeMs: count(environment.tabAgeMs),
  };
}

/** A trimmed, length-clamped string, or nothing when there was nothing to say. */
function text(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

function finite(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : value;
}

/** A whole, non-negative number — the shape every count in the contract has. */
function count(value: number | undefined): number | undefined {
  const known = finite(value);
  return known === undefined ? undefined : Math.max(0, Math.round(known));
}

function viewportOf(viewport: ClientEnvironmentSnapshot["viewport"]): ClientContext["viewport"] {
  if (viewport === undefined) return undefined;
  const w = count(viewport.w);
  const h = count(viewport.h);
  const dpr = finite(viewport.dpr);
  if (w === undefined || h === undefined || dpr === undefined) return undefined;
  return { w, h, dpr };
}

function screenOf(screen: ClientEnvironmentSnapshot["screen"]): ClientContext["screen"] {
  if (screen === undefined) return undefined;
  const w = count(screen.w);
  const h = count(screen.h);
  if (w === undefined || h === undefined) return undefined;
  return { w, h };
}
