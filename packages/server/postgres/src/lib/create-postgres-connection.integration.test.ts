import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestPostgres,
  type TestPostgres,
} from "../testing/start-test-postgres.js";
import { createPostgresConnection } from "./create-postgres-connection.js";

/**
 * What: a pool built with session settings starts every connection with
 * them, from its first statement and after a transaction resets local
 * settings; a pool built without them never has them.
 *
 * Why against a real server: the setting travels as a Postgres startup
 * option, and only a real server shows it took (a site's database tells
 * itself from the cloud's by one).
 */
describe("createPostgresConnection session settings (integration)", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startTestPostgres();
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
  });

  const SETTING = "kit_test.session_setting";

  async function settingOn(
    connection: ReturnType<typeof createPostgresConnection>,
  ): Promise<string | null | undefined> {
    const result = await connection.pool.query<{ value: string | null }>(
      "select current_setting($1, true) as value",
      [SETTING],
    );
    return result.rows[0]?.value;
  }

  it("starts every connection with the settings, and a pool without them has none", async () => {
    const withSetting = createPostgresConnection(
      {
        schema: {},
        connectionString: postgres.connectionString,
        sessionSettings: { [SETTING]: "on" },
      },
      { error: () => undefined },
    );
    const without = createPostgresConnection(
      { schema: {}, connectionString: postgres.connectionString },
      { error: () => undefined },
    );
    try {
      expect(await settingOn(withSetting)).toBe("on");
      const client = await withSetting.pool.connect();
      try {
        await client.query("begin");
        await client.query("select set_config($1, 'off', true)", [SETTING]);
        await client.query("commit");
      } finally {
        client.release();
      }
      expect(await settingOn(withSetting)).toBe("on");
      expect(await settingOn(without)).not.toBe("on");
    } finally {
      await Promise.all([withSetting.close(), without.close()]);
    }
  });
});
