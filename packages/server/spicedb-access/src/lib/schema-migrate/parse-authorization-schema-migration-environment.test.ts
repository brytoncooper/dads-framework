// Local and image migrators share one env contract: SpiceDB transport defaults
// and the in-image authorization journal folder.
import { describe, expect, it } from "vitest";
import { parseAuthorizationSchemaMigrationEnvironment } from "./parse-authorization-schema-migration-environment.js";

describe("parseAuthorizationSchemaMigrationEnvironment", () => {
  it("defaults the in-image journal folder and local SpiceDB transport", () => {
    expect(parseAuthorizationSchemaMigrationEnvironment({})).toEqual({
      endpoint: "localhost:50051",
      presharedKey: "spicedb-local-dev-key",
      insecure: true,
      journalFolder: "/app/authz-journal",
      datastorePostgresUrl: undefined,
      datastoreAdminUrl: undefined,
    });
  });

  it("accepts an explicit journal folder and datastore URL for a plant box", () => {
    expect(
      parseAuthorizationSchemaMigrationEnvironment({
        SPICEDB_ENDPOINT: "spicedb:50051",
        SPICEDB_PRESHARED_KEY: "plant-key",
        SPICEDB_INSECURE: "false",
        AUTHZ_JOURNAL_FOLDER: "/srv/authz-journal",
        SPICEDB_DATASTORE_CONN_URI: "postgres://postgres:secret@postgres:5432/spicedb?sslmode=disable",
      }),
    ).toEqual({
      endpoint: "spicedb:50051",
      presharedKey: "plant-key",
      insecure: false,
      journalFolder: "/srv/authz-journal",
      datastorePostgresUrl: "postgres://postgres:secret@postgres:5432/spicedb?sslmode=disable",
      datastoreAdminUrl: undefined,
    });
  });
});
