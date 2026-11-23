import { CONTAINER_PER_FILE } from "../start-test-postgres.js";

export const ALLOW_SLOW_TEST_MODE = "ALLOW_SLOW_TEST_MODE";
export const VITEST_ISOLATE = "VITEST_ISOLATE";

export const SLOW_LOCAL_TEST_MODE_MESSAGE =
  "This is the hour-long honesty job, not the local suite.\n" +
  "  npm run verify              # lint, typecheck, unit, integration, prettier, detect\n" +
  "  npm run test:integration    # container tier only, shared Postgres\n" +
  "To run the slow path on purpose: ALLOW_SLOW_TEST_MODE=1";

export function refuseSlowLocalTestMode(env: Readonly<Record<string, string | undefined>>): void {
  if (env["CI"] !== undefined) return;
  if (env[ALLOW_SLOW_TEST_MODE] === "1") return;
  if (env[CONTAINER_PER_FILE] !== "1" && env[VITEST_ISOLATE] !== "1") {
    return;
  }
  throw new Error(SLOW_LOCAL_TEST_MODE_MESSAGE);
}
