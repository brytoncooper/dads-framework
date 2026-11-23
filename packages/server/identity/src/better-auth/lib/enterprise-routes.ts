import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { withEnterpriseCallback } from "./enterprise-callback-context.js";
import { OIDC_CALLBACK, SAML_CALLBACK } from "./enterprise-plugin.js";
import { type EnterpriseSsoProvider } from "./enterprise-options.js";
import { IDENTITY_PATH } from "./identity-options.js";

const RELAY_COOKIE = "__Host-dads-sso-relay";
const OIDC_COOKIE = "__Host-dads-sso-state";
const LOCAL_OIDC_COOKIE = "dads-sso-local-state";
const SAML_METADATA = "/sso/saml2/sp/metadata";
const MAX_SAML_FORM_BYTES = 800_000;
type VendorHandler = (request: Request) => Promise<Response>;

export function createEnterpriseRoutes(
  providers: readonly EnterpriseSsoProvider[],
  origin: string,
  secret: string,
  vendor: VendorHandler,
) {
  return async (
    request: Request,
    route: string,
  ): Promise<Response | undefined> => {
    if (route === "POST /sign-in/sso")
      return start(request, providers, origin, secret, vendor);
    if (
      route === `GET ${OIDC_CALLBACK}` &&
      providers.some((provider) => provider.protocol === "oidc")
    )
      return oidcCallback(request, providers, origin, secret, vendor);
    if (route === `GET ${SAML_METADATA}`) {
      const url = new URL(request.url);
      if (
        !providers.some(
          (provider) =>
            provider.protocol === "saml" &&
            provider.id === url.searchParams.get("providerId"),
        )
      )
        return undefined;
      url.searchParams.set("format", "xml");
      return vendor(new Request(url, request));
    }
    const provider = providers.find(
      (candidate) =>
        candidate.protocol === "saml" &&
        route === `POST ${SAML_CALLBACK}/${candidate.id}`,
    );
    if (provider !== undefined)
      return samlCallback(request, provider, secret, vendor);
    return undefined;
  };
}

async function start(
  request: Request,
  providers: readonly EnterpriseSsoProvider[],
  origin: string,
  secret: string,
  vendor: VendorHandler,
): Promise<Response> {
  if (request.headers.get("origin") !== origin) return rejected(403);
  const body = await readSignInBody(request);
  if (body === null) return rejected(400);
  const provider = providers.find(
    (candidate) => candidate.id === body.providerId,
  );
  if (provider === undefined) return rejected(404);

  const callback = safeAppCallback(body.callbackURL, origin);
  if (callback === undefined) return rejected(400);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const response = await vendor(
    new Request(`${origin}${IDENTITY_PATH}/sign-in/sso`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: provider.id,
        callbackURL: callback.href,
        errorCallbackURL: callback.href,
      }),
    }),
  );
  if (!response.ok) return response;

  return bindBrowserState(response, provider, origin, secret);
}

async function readSignInBody(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    !("providerId" in body) ||
    typeof body.providerId !== "string" ||
    !("callbackURL" in body) ||
    typeof body.callbackURL !== "string"
  )
    return null;
  return { providerId: body.providerId, callbackURL: body.callbackURL };
}

async function bindBrowserState(
  response: Response,
  provider: EnterpriseSsoProvider,
  origin: string,
  secret: string,
): Promise<Response> {
  const result: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (
    typeof result !== "object" ||
    result === null ||
    !("url" in result) ||
    typeof result.url !== "string"
  )
    return rejected(502);
  const saml = provider.protocol === "saml";
  const state = new URL(result.url).searchParams.get(
    saml ? "RelayState" : "state",
  );
  if (state === null) return rejected(502);
  return withStateCookie(
    response,
    stateCookie(saml, origin),
    stateDigest(secret, provider, state),
    300,
  );
}

async function oidcCallback(
  request: Request,
  providers: readonly EnterpriseSsoProvider[],
  origin: string,
  secret: string,
  vendor: VendorHandler,
): Promise<Response> {
  const states = new URL(request.url).searchParams.getAll("state");
  const state = states[0];
  const cookie = stateCookie(false, origin);
  if (!state || states.length !== 1) return rejected(403);
  const provider = providers.find(
    (candidate) =>
      candidate.protocol === "oidc" &&
      matchesState(request, cookie, stateDigest(secret, candidate, state)),
  );
  if (provider === undefined) return rejected(403);
  const response = await withEnterpriseCallback(provider, () =>
    vendor(request),
  );
  return withStateCookie(response, cookie, "", 0);
}

function safeAppCallback(input: string, origin: string): URL | undefined {
  try {
    const url = new URL(input, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname === IDENTITY_PATH ||
      url.pathname.startsWith(`${IDENTITY_PATH}/`)
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function samlCallback(
  request: Request,
  provider: EnterpriseSsoProvider,
  secret: string,
  vendor: VendorHandler,
): Promise<Response> {
  const cookie = stateCookie(true, "");
  const form = await parseSamlForm(request);
  if (
    form === undefined ||
    !matchesState(
      request,
      cookie,
      stateDigest(secret, provider, form.RelayState),
    )
  )
    return rejected(403);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const callbackRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: new URLSearchParams(form),
  });
  const response = await withEnterpriseCallback(provider, () =>
    vendor(callbackRequest),
  );
  return withStateCookie(response, cookie, "", 0);
}

async function parseSamlForm(request: Request) {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/x-www-form-urlencoded" ||
    request.body === null
  )
    return undefined;
  const form = await readSamlForm(request.body);
  if (form === undefined) return undefined;
  const relayValues = form.getAll("RelayState");
  const assertionValues = form.getAll("SAMLResponse");
  if (
    relayValues.length !== 1 ||
    assertionValues.length !== 1 ||
    !relayValues[0] ||
    !assertionValues[0]
  )
    return undefined;
  return { RelayState: relayValues[0], SAMLResponse: assertionValues[0] };
}

async function readSamlForm(
  body: ReadableStream<Uint8Array>,
): Promise<URLSearchParams | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let data = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return new URLSearchParams(data + decoder.decode());
      length += chunk.value.byteLength;
      if (length > MAX_SAML_FORM_BYTES) {
        await reader.cancel();
        return undefined;
      }
      data += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function stateDigest(
  secret: string,
  provider: EnterpriseSsoProvider,
  state: string,
): string {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "dads-sso-browser-state-v1",
        provider.protocol,
        provider.id,
        state,
      ]),
    )
    .digest("hex");
}

function stateCookie(saml: boolean, origin: string) {
  if (saml) return { name: RELAY_COOKIE, attributes: "Secure; SameSite=None" };
  if (origin.startsWith("http:"))
    return { name: LOCAL_OIDC_COOKIE, attributes: "SameSite=Lax" };
  return { name: OIDC_COOKIE, attributes: "Secure; SameSite=Lax" };
}

function matchesState(
  request: Request,
  cookie: ReturnType<typeof stateCookie>,
  expected: string,
): boolean {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${cookie.name}=`))
    ?.slice(cookie.name.length + 1);
  return (
    value !== undefined &&
    /^[a-f0-9]{64}$/u.test(value) &&
    timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"))
  );
}

function withStateCookie(
  response: Response,
  cookie: ReturnType<typeof stateCookie>,
  digest: string,
  maxAge: number,
): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "set-cookie",
    `${cookie.name}=${digest}; Max-Age=${maxAge}; Path=/; HttpOnly; ${cookie.attributes}`,
  );
  return new Response(response.body, { status: response.status, headers });
}

function rejected(status: number): Response {
  return Response.json({ error: "enterprise-sso-request-denied" }, { status });
}
