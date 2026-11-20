import { describe, expect, it } from "vitest";
import { getInitials } from "./get-initials.js";

describe("getInitials", () => {
  it("handles two or more words: first and last character of each", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials(" walter  hartwell white ")).toBe("WW");
    expect(getInitials("John Paul Jones")).toBe("JJ");
  });

  it("handles single word: first character only", () => {
    expect(getInitials("ada")).toBe("A");
    expect(getInitials("George")).toBe("G");
    expect(getInitials("X")).toBe("X");
  });

  it("handles empty or whitespace-only input", () => {
    expect(getInitials("")).toBe("?");
    expect(getInitials("   ")).toBe("?");
    expect(getInitials("\t\n")).toBe("?");
  });

  it("handles astral and emoji-leading names safely", () => {
    // Emoji at the start of a name
    expect(getInitials("🎉Ada Lovelace")).toBe("🎉L");
    // Multi-codepoint emoji (astral characters)
    expect(getInitials("👨‍👩‍👧‍👦 Family Name")).toBe("👨N");
    // Emoji as single word
    expect(getInitials("🎉")).toBe("🎉");
  });
});
