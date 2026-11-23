import { fileURLToPath } from "node:url";

import { definePlugin } from "@dads-framework/core/plugin";

/** Install this schema only when the application uses the Postgres flag store. */
export const featureFlagsPostgresSchema = definePlugin({
  name: "feature-flags-postgres",
  contributes: {
    migrations: [
      {
        directory: fileURLToPath(new URL("../../src/postgres/migrations/", import.meta.url)),
      },
    ],
  },
});
