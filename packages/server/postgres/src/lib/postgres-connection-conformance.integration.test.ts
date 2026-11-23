import { Pool } from "pg";
import { afterAll, beforeAll, it } from "vitest";

import { systemActor } from "@dads-framework/core/audit-actor";

import {
  startTestPostgres,
  type TestPostgres,
} from "../testing/start-test-postgres.js";
import { createAttributedPool } from "./attributed-pool.js";
import { runPostgresPoolLaws } from "./postgres-pool-laws.js";

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.pool.query(
    "create table pool_conformance_writes (value integer primary key)",
  );
}, 180_000);

afterAll(async () => {
  await postgres.stop();
});

runPostgresPoolLaws(
  (options) => new Pool(options),
  (name, run) => {
    it(`native pg.Pool ${name}`, async () => {
      await run(postgres.connectionString, postgres.pool);
    });
  },
);
runPostgresPoolLaws(
  (options) =>
    createAttributedPool(options, () => systemActor("postgres-conformance")),
  (name, run) => {
    it(`attributed pool ${name}`, async () => {
      await run(postgres.connectionString, postgres.pool);
    });
  },
);
