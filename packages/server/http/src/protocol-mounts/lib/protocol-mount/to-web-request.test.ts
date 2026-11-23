/**
 * Better Auth's sign-up path clones the request TWICE: once in Better Call to
 * parse the body, once in the route itself to hand the caller's request to
 * `sendVerificationEmail`. Node 22 bundles undici 6.21, whose clone tees the
 * body, leaves branch one on the ORIGINAL request, and registers that branch
 * in a `FinalizationRegistry` keyed on the CLONE. When the collector takes the
 * discarded first clone it cancels the live request's own body, and the second
 * clone throws `TypeError: unusable` — sign-up answers 500, and every e2e file
 * whose `beforeAll` registers a user dies with it. Collection timing is the
 * only trigger, which is why the suite lost whole files under load and came
 * back green on a re-run.
 *
 * So the wall here is structural, not statistical: cloning must not tee. If a
 * clone leaves the original's body stream untouched, undici registered
 * nothing, and no collector can reach in and cancel a live request's body.
 */
import { describe, expect, it } from "vitest";
import { toWebRequest, type IncomingProtocolRequest } from "./to-web-request.js";

const payload = {
  email: "operator@example.com",
  password: "a-strong-password-123",
  name: "Operator",
};

function signUpRequest(): IncomingProtocolRequest {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: {
      host: "127.0.0.1:3000",
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "set-cookie": ["first=1", "second=2"],
    },
    body,
  };
}

describe("toWebRequest", () => {
  it("carries the method, absolute url and every header value across", () => {
    const request = toWebRequest(signUpRequest());

    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://127.0.0.1:3000/api/auth/sign-up/email");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("set-cookie")).toBe("first=1, second=2");
  });

  it("leaves the original body stream in place when the request is cloned", async () => {
    const request = toWebRequest(signUpRequest());
    const streamBeforeClone = request.body;

    // What Better Call does to read the body (better-call/dist/router.mjs).
    const parsed: unknown = await request.clone().json();

    expect(parsed).toEqual(payload);
    // undici's own clone swaps a tee branch in here and registers it against
    // the clone's lifetime. That registration IS the bug — refuse the tee.
    expect(request.body).toBe(streamBeforeClone);
    expect(request.bodyUsed).toBe(false);
  });

  it("clones again after the body has been parsed", async () => {
    const request = toWebRequest(signUpRequest());
    await request.clone().json();

    // What the sign-up route does (better-auth/dist/api/routes/sign-up.mjs).
    await expect(request.clone().json()).resolves.toEqual(payload);
  });

  it("gives a clone its own body, so reading one cannot disturb another", async () => {
    const request = toWebRequest(signUpRequest());

    const first = request.clone();
    const second = request.clone();
    await first.text();

    expect(second.bodyUsed).toBe(false);
    await expect(second.json()).resolves.toEqual(payload);
  });

  it("sends no body for a bodyless method", () => {
    const request = toWebRequest({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { host: "127.0.0.1:3000" },
      body: undefined,
    });

    expect(request.body).toBeNull();
  });
});
