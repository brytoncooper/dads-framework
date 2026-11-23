// Rolling clone replaces only spicedb_previous. Migrate must never drop the
// live SpiceDB database.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spiceDbDatastoreAdminUrl, spiceDbDatastoreDatabaseName } from "./clone-spice-db-datastore.js";

describe("cloneSpiceDbDatastore helpers", () => {
  it("points the admin connection at the postgres maintenance database", () => {
    expect(spiceDbDatastoreAdminUrl("postgres://postgres:secret@127.0.0.1:5432/spicedb?sslmode=disable")).toBe(
      "postgres://postgres:secret@127.0.0.1:5432/postgres?sslmode=disable",
    );
  });

  it("reads the SpiceDB datastore name from the URL path", () => {
    expect(spiceDbDatastoreDatabaseName("postgres://postgres:secret@127.0.0.1:5432/spicedb?sslmode=disable")).toBe(
      "spicedb",
    );
  });

  it("does not drop the live SpiceDB database", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "clone-spice-db-datastore.ts"), "utf8");
    expect(source).not.toMatch(/DROP DATABASE(?: IF EXISTS)?\s+spicedb\b/i);
  });
});
