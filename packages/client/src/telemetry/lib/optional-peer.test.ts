import { describe, expect, it } from "vitest";

import { loadOptionalPeer } from "./optional-peer.js";
import { loadSentryReactModule } from "./sentry-client-telemetry.js";

function missingModuleError(message: string, code?: "ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND"): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("loadOptionalPeer (client/telemetry)", () => {
  it("wraps ERR_MODULE_NOT_FOUND with subpath, package name, install hint, and cause", async () => {
    const cause = missingModuleError("Cannot find package '@sentry/react'", "ERR_MODULE_NOT_FOUND");

    const error = await loadOptionalPeer("@dads-framework/client/telemetry", "@sentry/react", () =>
      Promise.reject(cause),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected Error");
    expect(error.message).toBe(
      '@dads-framework/client/telemetry requires optional peer dependency "@sentry/react". Install it with: npm install @sentry/react',
    );
    expect(error.cause).toBe(cause);
  });

  it("wraps MODULE_NOT_FOUND and Cannot find module errors", async () => {
    await expect(
      loadOptionalPeer("@dads-framework/client/telemetry", "@sentry/react", () =>
        Promise.reject(missingModuleError("Cannot find module '@sentry/react'", "MODULE_NOT_FOUND")),
      ),
    ).rejects.toThrow(
      '@dads-framework/client/telemetry requires optional peer dependency "@sentry/react". Install it with: npm install @sentry/react',
    );
  });

  it("rethrows unrelated errors unchanged", async () => {
    const bug = new Error("Chunk blocked by browser extension");

    const caught = await loadOptionalPeer("@dads-framework/client/telemetry", "@sentry/react", () =>
      Promise.reject(bug),
    ).catch((error: unknown) => error);

    expect(caught).toBe(bug);
  });

  it("throws a friendly error from loadSentryReactModule when @sentry/react is missing and passes through other errors", async () => {
    const cause = missingModuleError("Cannot find package '@sentry/react'", "ERR_MODULE_NOT_FOUND");

    await expect(loadSentryReactModule(() => Promise.reject(cause))).rejects.toMatchObject({
      message:
        '@dads-framework/client/telemetry requires optional peer dependency "@sentry/react". Install it with: npm install @sentry/react',
      cause,
    });

    const unrelated = new TypeError("Failed to fetch dynamically imported module");
    await expect(loadSentryReactModule(() => Promise.reject(unrelated))).rejects.toBe(unrelated);
  });
});
