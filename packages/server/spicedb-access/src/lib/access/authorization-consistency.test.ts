/**
 * What/why: a write on this request must become the token the next read on
 * the same request uses, without each caller threading it by hand.
 */
import { describe, expect, it } from "vitest";
import {
  authorizationConsistencyTokenOnThisRequest,
  recordWrittenAuthorizationConsistency,
  runWithAuthorizationConsistency,
  writtenAuthorizationConsistencyOnThisRequest,
} from "@dads-framework/access/runtime";

describe("authorization consistency on this request", () => {
  it("starts from the inbound cookie token", () => {
    runWithAuthorizationConsistency("cookie-token", () => {
      expect(authorizationConsistencyTokenOnThisRequest()).toBe("cookie-token");
      expect(writtenAuthorizationConsistencyOnThisRequest()).toBeUndefined();
    });
  });

  it("a write replaces the inbound token for later reads on this request", () => {
    runWithAuthorizationConsistency("cookie-token", () => {
      recordWrittenAuthorizationConsistency("written-at-3");
      expect(authorizationConsistencyTokenOnThisRequest()).toBe("written-at-3");
      expect(writtenAuthorizationConsistencyOnThisRequest()).toBe(
        "written-at-3",
      );
    });
  });

  it("ignores an empty write token", () => {
    runWithAuthorizationConsistency("cookie-token", () => {
      recordWrittenAuthorizationConsistency("");
      expect(authorizationConsistencyTokenOnThisRequest()).toBe("cookie-token");
      expect(writtenAuthorizationConsistencyOnThisRequest()).toBeUndefined();
    });
  });

  it("does nothing when no request is in progress", () => {
    recordWrittenAuthorizationConsistency("written-at-3");
    expect(authorizationConsistencyTokenOnThisRequest()).toBeUndefined();
    expect(writtenAuthorizationConsistencyOnThisRequest()).toBeUndefined();
  });
});
