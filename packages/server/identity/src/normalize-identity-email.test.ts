import { expect, it } from "vitest";
import { normalizeIdentityEmail } from "./index.js";

it("normalizes invitation addresses and refuses malformed input", () => {
  expect(normalizeIdentityEmail("  Person+Team@Example.org  ")).toBe("person+team@example.org");
  expect(normalizeIdentityEmail(null)).toBeNull();
  expect(normalizeIdentityEmail("no-at.example.org")).toBeNull();
  expect(normalizeIdentityEmail("other@example.org\r\nBCC:x@example.org")).toBeNull();
  expect(normalizeIdentityEmail(`${"x".repeat(254)}@example.org`)).toBeNull();
});
