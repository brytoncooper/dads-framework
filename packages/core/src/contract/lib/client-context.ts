import { z } from "zod";

/**
 * Client-sent debugging environment for `request_log`
 * (docs/adr/20260910211247-0112-universal-audit-log-and-actor-context.md#request_log).
 *
 * This is diagnostic exhaust, not business data and never authorization
 * input: a client that omits it, lies in it, or sends garbage never fails a
 * request. The server decodes it with {@link decodeClientContext}, which
 * swallows every failure and returns `null` — the row is written with a null
 * context rather than the request being rejected.
 */
export const CLIENT_CONTEXT_HEADER = "x-client-context";

/**
 * Upper bound on the header's own length (the base64url text, not the decoded
 * JSON). Chosen to keep one debugging header well clear of proxy/header size
 * limits; an oversized header is treated exactly like a missing one.
 */
export const CLIENT_CONTEXT_MAX_BYTES = 4096;

const viewportSchema = z.strictObject({
  w: z.number().int(),
  h: z.number().int(),
  dpr: z.number(),
});

const screenSchema = z.strictObject({
  w: z.number().int(),
  h: z.number().int(),
});

/**
 * Shape of the decoded `x-client-context` header. `version` lets a future,
 * incompatible shape be told apart from this one instead of half-parsing
 * under strict mode; bump it and add a new literal branch rather than
 * changing what `1` means.
 *
 * `routeId` is the matched route template (e.g. `/orders/:orderId`), never
 * the raw path — the same identifier `request_log` stores instead of a path,
 * for the same reason (docs/adr/20260910211247-0112-universal-audit-log-and-actor-context.md).
 * The schema only bounds its length; it is the caller's job to pass a
 * template and not a URL.
 *
 * `os`/`electron`/`hostname`/`deviceId`/`outboxDepth`/`lastPullAt`/
 * `clockSkewMs` are kiosk-only extras — meaningless for `client: "web"` but
 * not worth a discriminated union for a best-effort debugging blob.
 */
export const clientContextSchema = z.strictObject({
  version: z.literal(1),
  client: z.enum(["web", "kiosk"]),
  build: z.string().min(1).max(128),
  timeZone: z.string().max(64),
  locale: z.string().max(32),
  routeId: z.string().max(256).optional(),
  viewport: viewportSchema.optional(),
  screen: screenSchema.optional(),
  touch: z.boolean().optional(),
  online: z.boolean().optional(),
  connection: z.string().max(32).optional(),
  deviceMemory: z.number().optional(),
  hardwareConcurrency: z.number().int().optional(),
  tabAgeMs: z.number().int().min(0).optional(),
  os: z.string().max(128).optional(),
  electron: z.string().max(32).optional(),
  hostname: z.string().max(128).optional(),
  deviceId: z.string().max(64).optional(),
  outboxDepth: z.number().int().min(0).optional(),
  lastPullAt: z.iso.datetime().optional(),
  clockSkewMs: z.number().int().optional(),
});

export type ClientContext = z.infer<typeof clientContextSchema>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** UTF-8 bytes to base64url text, no padding — the inverse of {@link fromBase64Url}. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url text back to UTF-8 bytes, or `null` for anything not valid base64url. */
function fromBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Encode a context for the `x-client-context` header. `btoa`/`atob` plus
 * `TextEncoder` rather than Node's `Buffer`: this module is shared with
 * browser and kiosk (Electron) callers through
 * the request transport package, and every runtime here —
 * browser and Node 24 alike — has the Web APIs but not all of them have
 * `Buffer`.
 */
export function encodeClientContext(context: ClientContext): string {
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  return toBase64Url(bytes);
}

/**
 * Decode an `x-client-context` header value. Never throws: a missing,
 * oversized, malformed, or schema-invalid value is reported as `null` so the
 * caller can log it and move on rather than reject the request over a
 * debugging header.
 */
export function decodeClientContext(headerValue: string | undefined): ClientContext | null {
  if (headerValue === undefined) return null;
  if (headerValue.length > CLIENT_CONTEXT_MAX_BYTES) return null;

  const bytes = fromBase64Url(headerValue);
  if (bytes === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  const parsed = clientContextSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
