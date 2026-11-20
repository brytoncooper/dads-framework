import { PostgreSqlContainer } from "@testcontainers/postgresql";
import {
  TEMPLATE_DATABASE,
  applyCheckedInSchema,
} from "../start-test-postgres.js";
import {
  postgresStorageSettings,
  testPostgresStorage,
  withPostgresMemoryLimit,
  withPostgresStorage,
} from "../test-postgres-storage.js";

/**
 * `max_connections` on the shared test Postgres, set explicitly rather than
 * left at the image's 100. Every Vitest worker of every project attached to
 * one integration run opens its pools against this ONE server, so it is the
 * ceiling those pools are budgeted against (application integration suites check their own
 * worst case against it in `e2e-postgres-connection-budget.ts`). Idle
 * slots cost nothing; a refused connection fails a test with
 * `sorry, too many clients already`.
 */
export const SHARED_TEST_POSTGRES_MAX_CONNECTIONS = 300;

/**
 * Start the shared container and migrate the template. Called by the vitest
 * `globalSetup`, once per process — never by a test.
 */
export async function startMigratedTemplatePostgres(): Promise<{
  readonly url: string;
  readonly containerId: string;
  readonly stop: () => Promise<void>;
}> {
  const container = await startSharedPostgresContainer();
  const url = container.getConnectionUri();
  await applyCheckedInSchema(url);

  return {
    url,
    containerId: container.getId(),
    stop: () => container.stop().then(() => undefined),
  };
}

async function startSharedPostgresContainer() {
  const previousRyuk = process.env["TESTCONTAINERS_RYUK_DISABLED"];
  process.env["TESTCONTAINERS_RYUK_DISABLED"] = "true";
  try {
    const storage = testPostgresStorage();
    const container = new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase(TEMPLATE_DATABASE)
      .withLabels({ "dads.test.shared-postgres": "1" })
      .withCommand([
        "postgres",
        "-c",
        `max_connections=${String(SHARED_TEST_POSTGRES_MAX_CONNECTIONS)}`,
        ...postgresStorageSettings(storage),
      ]);
    return await withPostgresMemoryLimit(
      withPostgresStorage(container, storage),
      storage,
    ).start();
  } finally {
    if (previousRyuk === undefined) {
      Reflect.deleteProperty(process.env, "TESTCONTAINERS_RYUK_DISABLED");
    } else {
      process.env["TESTCONTAINERS_RYUK_DISABLED"] = previousRyuk;
    }
  }
}
