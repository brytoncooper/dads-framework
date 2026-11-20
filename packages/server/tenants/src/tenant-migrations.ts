import { fileURLToPath } from "node:url";

/** A migration contribution for the tenant tables. */
export const tenantMigrations = {
  directory: fileURLToPath(new URL("../src/migrations/", import.meta.url)),
};
