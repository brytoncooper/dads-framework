import { describe, expect, it } from "vitest";

import { ACCESS_REFUSAL_VALUE } from "@dads-framework/contract";

import { isAccessRefusal } from "./access-refusal.js";

describe("isAccessRefusal", () => {
  it("reads a 404 the access edge marked as a refusal", () => {
    expect(isAccessRefusal(404, ACCESS_REFUSAL_VALUE)).toBe(true);
  });

  it("reads an unmarked 404 as a record that is not there", () => {
    expect(isAccessRefusal(404, null)).toBe(false);
    expect(isAccessRefusal(404, "something-else")).toBe(false);
  });

  it("reads an unmarked 403 as another rule saying no, not the access edge", () => {
    expect(isAccessRefusal(403, null)).toBe(false);
  });

  it("leaves a signed-out 401 and a success alone", () => {
    expect(isAccessRefusal(401, null)).toBe(false);
    expect(isAccessRefusal(200, ACCESS_REFUSAL_VALUE)).toBe(false);
  });
});
