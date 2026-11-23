/**
 * What: a transport failure stays an instance of its own class even when a
 * script on the page has replaced the global `Error` with a constructor that
 * returns an object of its own.
 * Why: every "is this an expected refusal?" decision in the app — whether to
 * report a failure, whether a session expired, which refusal a screen shows —
 * is an `instanceof` check on these classes. Production saw a browser whose
 * injected script did exactly this: a 409 and a
 * 401 lost their class, were reported as faults, and the invitation screen
 * showed "Could not open the invitation" instead of "Invitation Already Used".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const originalError = globalThis.Error;

afterEach(() => {
  globalThis.Error = originalError;
});

/**
 * Loads a fresh copy of the module while `Error` is replaced the way the
 * production browser's injected script replaced it: a constructor that builds
 * and returns a plain `Error`, so `super()` hands back an object whose
 * prototype is not the subclass's.
 */
async function loadWithReplacedErrorConstructor() {
  function replacementError(message?: string, options?: ErrorOptions): Error {
    return new originalError(message, options);
  }
  replacementError.prototype = originalError.prototype;
  Object.setPrototypeOf(replacementError, originalError);
  Reflect.set(globalThis, "Error", replacementError);

  vi.resetModules();
  const loaded = await import("./api-error.js");
  globalThis.Error = originalError;
  return loaded;
}

describe("transport errors under a replaced Error constructor", () => {
  it("keep an API refusal recognisable as an ApiError", async () => {
    const { ApiError, readClientFailure, toApiError } = await loadWithReplacedErrorConstructor();

    const refusal = toApiError(
      409,
      {
        error: {
          code: "ACCOUNT_INVITATION_ALREADY_ACCEPTED",
          message: "Account invitation was already accepted",
        },
      },
      "req-1",
    );

    expect(refusal).toBeInstanceOf(ApiError);
    expect(readClientFailure(refusal)).toEqual({
      kind: "api",
      status: 409,
      code: "ACCOUNT_INVITATION_ALREADY_ACCEPTED",
    });
  });

  it("keep a missing session recognisable as an UnauthorizedError", async () => {
    const { UnauthorizedError, readClientFailure, toApiError } = await loadWithReplacedErrorConstructor();

    const missingSession = toApiError(
      401,
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        },
      },
      "req-2",
    );

    expect(missingSession).toBeInstanceOf(UnauthorizedError);
    expect(readClientFailure(missingSession)).toEqual({
      kind: "session-expired",
    });
  });

  it("keep an unanswered request recognisable as a NetworkError", async () => {
    const { NetworkError } = await loadWithReplacedErrorConstructor();

    expect(new NetworkError(new TypeError("offline"))).toBeInstanceOf(NetworkError);
  });
});
