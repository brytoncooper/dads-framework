import { expect, it } from "vitest";
import { validatedOrigin } from "./identity-options.js";

it("allows HTTPS origins and loopback development only", () => {
  expect(validatedOrigin("https://example.test/")).toBe("https://example.test");
  expect(validatedOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  expect(() => validatedOrigin("http://example.test")).toThrow("requires HTTPS");
  expect(() => validatedOrigin("https://example.test/subpath")).toThrow("bare origin");
  expect(() => validatedOrigin("https://operator@example.test/")).toThrow("bare origin");
});
