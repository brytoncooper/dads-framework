import type { PostgresPool } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureBetterAuth } from "./configure-better-auth.js";
import type { BetterAuthIdentityOptions } from "./identity-options.js";

const stubPool: PostgresPool = {
  connect: () => Promise.reject(new Error("Pool not used in configuration unit test")),
  end: () => Promise.resolve(),
};

function baseOptions(overrides: Partial<BetterAuthIdentityOptions> = {}): BetterAuthIdentityOptions {
  return {
    database: { pool: stubPool },
    baseUrl: "https://example.test",
    secret: "0123456789abcdef0123456789abcdef",
    enqueueEmail: () => Promise.resolve(),
    canInvite: () => Promise.resolve(false),
    ...overrides,
  };
}

describe("configureBetterAuth", () => {
  afterEach(() => {
    vi.doUnmock("@better-auth/sso");
    vi.resetModules();
  });

  it("enables rate limiting by default and allows explicit opt-out", () => {
    const defaultAuth = configureBetterAuth(baseOptions(), "https://example.test", () => undefined);
    expect(defaultAuth.options.rateLimit.enabled).toBe(true);

    const emptyRateLimit = configureBetterAuth(baseOptions({ rateLimit: {} }), "https://example.test", () => undefined);
    expect(emptyRateLimit.options.rateLimit.enabled).toBe(true);

    const disabledAuth = configureBetterAuth(
      baseOptions({ rateLimit: { enabled: false } }),
      "https://example.test",
      () => undefined,
    );
    expect(disabledAuth.options.rateLimit.enabled).toBe(false);
  });

  it("initializes password-only identity without loading @better-auth/sso", async () => {
    vi.resetModules();
    vi.doMock("@better-auth/sso", () => {
      throw new Error("Cannot find module '@better-auth/sso'");
    });

    const { createBetterAuthIdentity } = await import("../index.js");
    const identity = createBetterAuthIdentity(baseOptions());
    expect(typeof identity.handle).toBe("function");
    expect(typeof identity.readSession).toBe("function");
  });
});
