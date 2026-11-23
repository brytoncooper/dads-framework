/**
 * Fastify request → WHATWG `Request`, for the protocol mounts whose vendor
 * handler speaks fetch (Better Auth, `mount-better-auth.ts`).
 */

/** The slice of an incoming fastify request this translation reads. */
export type IncomingProtocolRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Raw bytes — the mount parses every content type as a buffer. */
  readonly body: unknown;
};

/**
 * A request whose clones re-read the same bytes instead of sharing a stream.
 *
 * Node 22 bundles undici 6.21, whose `cloneBody(instance, body)` tees the
 * body, leaves branch one on the ORIGINAL request, hands branch two to the
 * clone, and registers branch ONE in a `FinalizationRegistry` keyed on the
 * clone. Better Call clones the request to parse its body and drops that
 * clone; Better Auth then clones the original again on the sign-up and
 * sign-in paths, to pass the caller's request to `sendVerificationEmail`. If a
 * collection lands between the two, the registry cancels the LIVE request's
 * own body stream, the second clone throws `TypeError: unusable`, and the
 * route answers 500. Collection timing is the entire trigger — which is how a
 * green suite mass-fails under load and passes on a re-run. undici 7 moved
 * that registration onto `Response` alone; Node 22 does not carry the fix.
 *
 * The mount has already buffered the whole body, so a clone never needs to
 * share a stream with anybody: it re-reads the same immutable bytes. No tee,
 * nothing registered, nothing for a collector to cancel.
 */
class BufferedProtocolRequest extends Request {
  readonly #url: URL;
  readonly #init: RequestInit;

  constructor(url: URL, init: RequestInit) {
    super(url, init);
    this.#url = url;
    this.#init = init;
  }

  override clone(): Request {
    return new BufferedProtocolRequest(this.#url, this.#init);
  }
}

function toWebHeaders(request: IncomingProtocolRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.append(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

export function toWebRequest(request: IncomingProtocolRequest): Request {
  const host = request.headers["host"];
  const url = new URL(request.url, `http://${typeof host === "string" ? host : "localhost"}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : undefined;
  return new BufferedProtocolRequest(url, {
    method: request.method,
    headers: toWebHeaders(request),
    ...(hasBody && body ? { body } : {}),
  });
}
