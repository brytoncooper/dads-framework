/**
 * What: a mutation's `meta` is read as "the screen presents this failure" only
 * when it carries the exact inline declaration.
 * Why: the global failure notice stands down on that answer, so a loose read
 * would silence a failure nobody shows.
 */
import { describe, expect, it } from "vitest";

import {
  FAILURE_PRESENTED_INLINE,
  isFailurePresentedInline,
} from "./failure-presentation.js";

describe("isFailurePresentedInline", () => {
  it("recognizes the inline declaration", () => {
    expect(isFailurePresentedInline(FAILURE_PRESENTED_INLINE)).toBe(true);
  });

  it("treats a mutation without meta as globally presented", () => {
    expect(isFailurePresentedInline(undefined)).toBe(false);
    expect(isFailurePresentedInline(null)).toBe(false);
  });

  it("ignores meta that does not declare inline presentation", () => {
    expect(isFailurePresentedInline({})).toBe(false);
    expect(isFailurePresentedInline({ failurePresentation: "global" })).toBe(
      false,
    );
    expect(isFailurePresentedInline({ failurePresentation: true })).toBe(false);
  });
});
