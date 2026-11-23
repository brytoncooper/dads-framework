/**
 * What/why: the write token has to survive the HTTP round-trip so the next
 * list request can ask SpiceDB for a snapshot at least as fresh as that write.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_CONSISTENCY_COOKIE,
  authorizationConsistencyClearCookie,
  authorizationConsistencySetCookie,
  authorizationConsistencyTokenFromCookieHeader,
} from "@dads-framework/access/runtime";

describe("authorization consistency cookie", () => {
  it("reads the token from a cookie header that also carries other cookies", () => {
    expect(
      authorizationConsistencyTokenFromCookieHeader(
        `session=abc; ${AUTHORIZATION_CONSISTENCY_COOKIE}=written-at-3; other=1`,
      ),
    ).toBe("written-at-3");
  });

  it("decodes a token that needed escaping", () => {
    const setCookie = authorizationConsistencySetCookie("a+b/c==");
    const tokenPair = setCookie.split(";", 1)[0] ?? "";
    const header = tokenPair;
    expect(authorizationConsistencyTokenFromCookieHeader(header)).toBe(
      "a+b/c==",
    );
  });

  it("returns nothing when the cookie is absent", () => {
    expect(
      authorizationConsistencyTokenFromCookieHeader("session=abc"),
    ).toBeUndefined();
  });

  it("writes an HttpOnly Lax cookie on the API path", () => {
    expect(authorizationConsistencySetCookie("written-at-3")).toBe(
      `${AUTHORIZATION_CONSISTENCY_COOKIE}=written-at-3; Path=/api; HttpOnly; SameSite=Lax`,
    );
  });

  it("marks the cookie Secure on HTTPS", () => {
    expect(
      authorizationConsistencySetCookie("written-at-3", { secure: true }),
    ).toContain("Secure");
  });

  it("expires the cookie on the same Path so sign-out can drop it", () => {
    expect(authorizationConsistencyClearCookie()).toBe(
      `${AUTHORIZATION_CONSISTENCY_COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  });

  it("marks the expired cookie Secure on HTTPS", () => {
    expect(authorizationConsistencyClearCookie({ secure: true })).toContain(
      "Secure",
    );
  });
});
