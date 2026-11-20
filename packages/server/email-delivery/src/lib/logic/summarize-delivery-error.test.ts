/**
 * `last_error` is read by operators and copied into logs, so the summary has
 * to stay short and carry no body (INV-EMAILDELIVERY-4). A thrown value that
 * is not an Error is named by its shape only — stringifying it is exactly how
 * a rendered email would end up in the column.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DELIVERY_ERROR_SUMMARY_LENGTH,
  deliveryErrorName,
  summarizeDeliveryError,
} from "./summarize-delivery-error.js";

describe("deliveryErrorName", () => {
  it("gives a log the error class and never its message", () => {
    expect(deliveryErrorName(new TypeError("dana@example.test bounced"))).toBe(
      "TypeError",
    );
  });

  it("names a thrown non-Error without inspecting it", () => {
    expect(deliveryErrorName({ html: "<p>secret</p>" })).toBe("UnknownError");
  });
});

describe("summarizeDeliveryError", () => {
  it("names the error class and its message", () => {
    expect(summarizeDeliveryError(new TypeError("fetch failed"))).toBe(
      "TypeError: fetch failed",
    );
  });

  it("truncates a vendor error page", () => {
    const summary = summarizeDeliveryError(new Error("x".repeat(5_000)));

    expect(summary.length).toBe(MAX_DELIVERY_ERROR_SUMMARY_LENGTH);
  });

  it("never stringifies a thrown non-Error, which could be the message", () => {
    const summary = summarizeDeliveryError({
      html: "<p>Dear Dana, your code is 4821</p>",
    });

    expect(summary).toBe("UnknownError: object");
    expect(summary).not.toContain("Dana");
    expect(summary).not.toContain("4821");
  });

  it("names a thrown string without quoting it", () => {
    expect(summarizeDeliveryError("dana@example.test bounced")).toBe(
      "UnknownError: string",
    );
  });
});
