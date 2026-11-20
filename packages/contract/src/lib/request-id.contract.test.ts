import { describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER } from "./request-id.js";

/**
 * The one place this string is written twice. Clients, logs and the error
 * envelope's `requestId` all key on this spelling, so changing it has to be a
 * deliberate edit here rather than a rename that follows a symbol around.
 */
describe("REQUEST_ID_HEADER", () => {
  it("names the correlation header every service reads and echoes", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});
