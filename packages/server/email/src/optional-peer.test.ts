import { describe, expect, it } from "vitest";

import { loadResendModule } from "./lib/resend-email-sender.js";
import { loadOptionalPeer } from "./optional-peer.js";
import { loadReactEmailRender } from "./templates/lib/email-document-renderer.js";

function missingModuleError(
  message: string,
  code?: "ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND",
): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("loadOptionalPeer (email)", () => {
  it("wraps ERR_MODULE_NOT_FOUND with subpath, package name, install hint, and cause", async () => {
    const cause = missingModuleError(
      "Cannot find package 'resend'",
      "ERR_MODULE_NOT_FOUND",
    );

    const error = await loadOptionalPeer(
      "@dads-framework/email",
      "resend",
      () => Promise.reject(cause),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected Error");
    expect(error.message).toBe(
      '@dads-framework/email requires optional peer dependency "resend". Install it with: npm install resend',
    );
    expect(error.cause).toBe(cause);
  });

  it("wraps MODULE_NOT_FOUND and Cannot find module errors", async () => {
    await expect(
      loadOptionalPeer(
        "@dads-framework/email/templates",
        "@react-email/render",
        () =>
          Promise.reject(
            missingModuleError(
              "Cannot find module '@react-email/render'",
              "MODULE_NOT_FOUND",
            ),
          ),
      ),
    ).rejects.toThrow(
      '@dads-framework/email/templates requires optional peer dependency "@react-email/render". Install it with: npm install @react-email/render',
    );
  });

  it("rethrows unrelated errors unchanged", async () => {
    const bug = new Error("Unexpected initialization failure");

    const caught = await loadOptionalPeer(
      "@dads-framework/email",
      "resend",
      () => Promise.reject(bug),
    ).catch((error: unknown) => error);

    expect(caught).toBe(bug);
  });

  it("throws a friendly error from loadResendModule when resend is missing and passes through other errors", async () => {
    const cause = missingModuleError(
      "Cannot find package 'resend'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      loadResendModule(() => Promise.reject(cause)),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/email requires optional peer dependency "resend". Install it with: npm install resend',
      cause,
    });

    const unrelated = new TypeError("Resend client crashed");
    await expect(
      loadResendModule(() => Promise.reject(unrelated)),
    ).rejects.toBe(unrelated);
  });

  it("throws a friendly error from loadReactEmailRender when @react-email/render is missing and passes through other errors", async () => {
    const cause = missingModuleError(
      "Cannot find package '@react-email/render'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      loadReactEmailRender(() => Promise.reject(cause)),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/email/templates requires optional peer dependency "@react-email/render". Install it with: npm install @react-email/render',
      cause,
    });

    const unrelated = new SyntaxError("Broken renderer bundle");
    await expect(
      loadReactEmailRender(() => Promise.reject(unrelated)),
    ).rejects.toBe(unrelated);
  });
});
