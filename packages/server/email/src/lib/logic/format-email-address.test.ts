/**
 * Header rendering is where a display name can break a message: an unquoted
 * comma splits one addressee into two, and an unquoted angle bracket ends the
 * address early. These tests pin when a name gets quoted and that the quoted
 * form escapes what would otherwise close it.
 */
import { describe, expect, it } from "vitest";
import { formatEmailAddress, formatEmailAddresses } from "./format-email-address.js";

describe("formatEmailAddress", () => {
  it("renders a bare address when there is no display name", () => {
    expect(formatEmailAddress({ address: "alice@example.com" })).toBe("alice@example.com");
  });

  it("treats an all-whitespace display name as no name at all", () => {
    expect(formatEmailAddress({ address: "alice@example.com", name: "   " })).toBe("alice@example.com");
  });

  it("leaves an ordinary display name unquoted", () => {
    expect(formatEmailAddress({ address: "alice@example.com", name: "Alice Doe" })).toBe(
      "Alice Doe <alice@example.com>",
    );
  });

  it("quotes a name holding a comma so it stays one addressee", () => {
    expect(formatEmailAddress({ address: "alice@example.com", name: "Doe, Alice" })).toBe(
      '"Doe, Alice" <alice@example.com>',
    );
  });

  it("quotes a name holding angle brackets", () => {
    expect(formatEmailAddress({ address: "alice@example.com", name: "A <B> C" })).toBe('"A <B> C" <alice@example.com>');
  });

  it("quotes a non-ascii name", () => {
    expect(formatEmailAddress({ address: "rene@example.com", name: "René" })).toBe('"René" <rene@example.com>');
  });

  it("escapes the quote and backslash that would close the quoted name", () => {
    expect(
      formatEmailAddress({
        address: "alice@example.com",
        name: 'Ali "The\\Ace" Doe',
      }),
    ).toBe('"Ali \\"The\\\\Ace\\" Doe" <alice@example.com>');
  });
});

describe("formatEmailAddresses", () => {
  it("joins every addressee with a comma and a space", () => {
    expect(
      formatEmailAddresses([{ address: "alice@example.com", name: "Alice" }, { address: "bob@example.com" }]),
    ).toBe("Alice <alice@example.com>, bob@example.com");
  });

  it("renders an empty list as an empty string", () => {
    expect(formatEmailAddresses([])).toBe("");
  });
});
