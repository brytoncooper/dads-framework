import { describe, expect, it } from "vitest";

import { ACCESS_REFUSAL_HEADER } from "./access-refusal.js";

/**
 * The one place this string is written twice. The API's access edge sets it
 * and the web transport and the persona page sweep read it, so changing it has
 * to be a deliberate edit here.
 */
describe("ACCESS_REFUSAL_HEADER", () => {
  it("names the header that marks an access refusal", () => {
    expect(ACCESS_REFUSAL_HEADER).toBe("x-access-refusal");
  });
});
