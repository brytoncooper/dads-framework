import {
  CLIENT_CONTEXT_MAX_BYTES,
  encodeClientContext,
  type ClientContext,
} from "@dads-framework/contract";

/**
 * The debugging environment every outbound request describes itself with
 * (`x-client-context`).
 *
 * A module-level channel rather than an argument on each call, for the same
 * reason as `request-locale.ts`: every request carries it and no call site
 * should have to remember. The app's composition root is the one place that
 * holds the router, the baked build stamp, and the browser globals, so it is
 * what calls `setClientContextProvider`.
 *
 * The provider is asked per request rather than once at import, because the
 * answer changes as the reader navigates, resizes, or goes offline.
 */

type ClientContextProvider = () => ClientContext | undefined;

let describeClient: ClientContextProvider | null = null;

/**
 * Describe this client on every request from here on, or pass `null` to stop.
 */
export function setClientContextProvider(
  provider: ClientContextProvider | null,
): void {
  describeClient = provider;
}

/**
 * The header value the next request will carry, or `undefined` when there is
 * nothing to say.
 *
 * This is diagnostic exhaust, so it fails silent in every direction: no
 * provider, a provider that returns nothing, a provider that throws, or a
 * context too large for the header budget all drop the header rather than
 * disturb the request. A dropped header costs a debugging detail; a thrown one
 * would cost the user their action.
 */
export function currentClientContextHeader(): string | undefined {
  if (describeClient === null) return undefined;
  try {
    const context = describeClient();
    if (context === undefined) return undefined;
    const encoded = encodeClientContext(context);
    return encoded.length > CLIENT_CONTEXT_MAX_BYTES ? undefined : encoded;
  } catch {
    return undefined;
  }
}
