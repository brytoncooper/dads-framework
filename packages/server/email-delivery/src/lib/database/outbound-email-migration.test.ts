/** The release loader must load the outbox migration without application aliases. */
import { createJiti } from "jiti";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("outbound email migration", () => {
  it("loads through the release migrator's standalone TypeScript loader", async () => {
    const filePath = join(
      import.meta.dirname,
      "migrations/20260911220133_outbound_emails.migration.ts",
    );
    const jiti = createJiti(filePath);

    const loaded = await jiti.import(filePath);
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("up" in loaded) ||
      !("down" in loaded)
    ) {
      throw new Error("migration must export up and down");
    }

    expect(loaded.up).toBeTypeOf("function");
    expect(loaded.down).toBeTypeOf("function");
  });
});
