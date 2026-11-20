import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mintUuidV7 } from "./mint-uuid-v7.js";

describe("mintUuidV7", () => {
  it("produces ids that pass z.uuidv7()", () => {
    const id = mintUuidV7(1_700_000_000_000);
    expect(z.uuidv7().safeParse(id).success).toBe(true);
    expect(id.slice(14, 15)).toBe("7");
  });

  it("orders two mints with increasing timestamps lexicographically", () => {
    const earlier = mintUuidV7(1_700_000_000_000);
    const later = mintUuidV7(1_700_000_000_100);
    expect(earlier < later).toBe(true);
  });
});
