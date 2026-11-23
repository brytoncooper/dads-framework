// Sibling URLs keep host credentials and only change the database name so a
// one-shot adopt can build an expected catalog on the same Postgres.
import { describe, expect, it } from "vitest";
import { databaseNameFromUrl, siblingDatabaseUrl } from "./sibling-database-url.js";

describe("siblingDatabaseUrl", () => {
  it("keeps credentials and query flags", () => {
    expect(siblingDatabaseUrl("postgresql://app:secret@postgres:5432/app?sslmode=require", "dads_adopt_ab")).toBe(
      "postgresql://app:secret@postgres:5432/dads_adopt_ab?sslmode=require",
    );
  });

  it("reads the current database name", () => {
    expect(databaseNameFromUrl("postgresql://app:secret@postgres:5432/app")).toBe("app");
  });
});
