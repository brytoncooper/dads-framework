import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_PER_FILE,
  findWorkspaceRoot,
  SHARED_TEST_POSTGRES_URL,
} from "../start-test-postgres.js";
import {
  claimSharedTestPostgresLease,
  decideSharedTestPostgres,
  readSharedTestPostgresLease,
  sharedTestPostgresLeasePath,
  waitForSharedTestPostgresUrl,
  writeSharedTestPostgresLease,
} from "./decide-shared-test-postgres.js";
import { refuseDisabledContainerCleanup } from "./refuse-disabled-container-cleanup.js";
import {
  applyRamStorageFallback,
  awaitEnoughTestMemory,
  capVitestWorkersToFreeMemory,
  type VitestProjectWorkers,
} from "./refuse-low-memory-runs.js";
import { refuseSlowLocalTestMode } from "./refuse-slow-local-test-mode.js";
import {
  acquireContainerTierSlot,
  currentNxRunId,
  processIsAlive,
  shouldHoldContainerTestRunLock,
} from "./refuse-stacked-container-runs.js";
import {
  describeRemovedTestcontainers,
  dockerCli,
  removeStaleTestcontainers,
} from "./remove-stale-testcontainers.js";
import { isContainerTestRun } from "./skip-unless-container-tests.js";
import { startMigratedTemplatePostgres } from "./start-migrated-template-postgres.js";
import {
  TEST_DATABASE_RUN_PREFIX,
  verifySchemaKeyedSuite,
} from "./verify-schema-keyed-suite.js";

/**
 * Vitest `globalSetup` for every project whose suites need a real Postgres.
 *
 * One container per Nx integration run: the first project migrates a template,
 * later projects attach via a lease file (or an inherited
 * `SHARED_TEST_POSTGRES_URL` from `run-integration-gate.ts`).
 * Each test file still clones that template into a private database
 * (`startTestPostgres`). The process is shared; the data never is
 * (docs/testing/speed.md).
 *
 * `CONTAINER_PER_FILE=1` skips the shared container entirely — the nightly
 * honesty job.
 */
export default async function setup(
  project?: VitestProjectWorkers,
): Promise<() => Promise<void>> {
  refuseDisabledContainerCleanup(process.env);
  refuseSlowLocalTestMode(process.env);

  if (!isContainerTestRun(process.env)) {
    return () => Promise.resolve();
  }

  const releaseLock = shouldHoldContainerTestRunLock(process.env)
    ? await acquireContainerTierSlot("integration", {
        beforeTake: async () => {
          await awaitEnoughTestMemory("integration");
        },
      })
    : (): void => undefined;

  if (project !== undefined) {
    await capVitestWorkersToFreeMemory(project, availableParallelism());
  }

  // Before any container starts, so this run's containers and every worker
  // that inherits the env agree on the storage.
  await applyRamStorageFallback(process.env);

  await sweepLocalTestcontainers();

  if (process.env[CONTAINER_PER_FILE] === "1") {
    return () => {
      releaseLock();
      return Promise.resolve();
    };
  }

  return prepareSharedPostgres(releaseLock);
}

async function sweepLocalTestcontainers(): Promise<void> {
  if (process.env["CI"] !== undefined) return;
  const swept = await removeStaleTestcontainers(dockerCli(), new Date());
  const line = describeRemovedTestcontainers(swept);
  if (line !== null) process.stdout.write(`${line}\n`);
}

async function prepareSharedPostgres(
  releaseLock: () => void,
): Promise<() => Promise<void>> {
  const leasePath = sharedTestPostgresLeasePath();
  const runId = currentNxRunId();
  const decision = decideSharedTestPostgres({
    env: process.env,
    lease: readSharedTestPostgresLease(leasePath),
    runId,
    isAlive: processIsAlive,
  });

  if (decision.action === "use-inherited" || decision.action === "use-lease") {
    process.env[SHARED_TEST_POSTGRES_URL] = decision.url;
    return teardownAfterVerifying(decision.url, releaseLock);
  }

  if (decision.action === "wait") {
    return attachWhenReady(leasePath, releaseLock);
  }

  const pending = {
    runId,
    starterPid: process.pid,
    url: null,
    startedAt: new Date().toISOString(),
  };
  if (decision.action === "steal") {
    writeSharedTestPostgresLease(leasePath, pending);
  } else if (!claimSharedTestPostgresLease(leasePath, pending)) {
    return attachWhenReady(leasePath, releaseLock);
  }

  const shared = await startMigratedTemplatePostgres();
  writeSharedTestPostgresLease(leasePath, {
    runId,
    starterPid: process.pid,
    url: shared.url,
    startedAt: new Date().toISOString(),
  });
  holdSharedPostgresUntilNxExits(shared.containerId, runId);
  process.env[SHARED_TEST_POSTGRES_URL] = shared.url;
  process.stdout.write("shared test postgres ready — later projects attach\n");
  return teardownAfterVerifying(shared.url, releaseLock);
}

/**
 * Names this process's private databases, and on teardown checks that a
 * schema-keyed suite's hash covered every table they touched
 * (verify-schema-keyed-suite.ts). A miss fails the run.
 */
function teardownAfterVerifying(
  sharedUrl: string,
  releaseLock: () => void,
): () => Promise<void> {
  const prefix = `p${String(process.pid)}${Date.now().toString(36)}`;
  process.env[TEST_DATABASE_RUN_PREFIX] = prefix;
  return async () => {
    try {
      await verifySchemaKeyedSuite({
        sharedUrl,
        prefix,
        env: process.env,
        workspaceRoot: findWorkspaceRoot(),
      });
    } catch (error) {
      // Vitest only logs a teardown error ("error during close") and keeps
      // the exit code its tests earned, so a miss would pass silently. It
      // never lowers an exit code it has been given; this raises it.
      process.exitCode = 1;
      throw error;
    } finally {
      Reflect.deleteProperty(process.env, SHARED_TEST_POSTGRES_URL);
      Reflect.deleteProperty(process.env, TEST_DATABASE_RUN_PREFIX);
      releaseLock();
    }
  };
}

function holdSharedPostgresUntilNxExits(
  containerId: string,
  nxPid: number,
): void {
  const script = fileURLToPath(
    new URL("./hold-shared-test-postgres.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [script, containerId, String(nxPid)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function attachWhenReady(
  leasePath: string,
  releaseLock: () => void,
): Promise<() => Promise<void>> {
  const url = await waitForSharedTestPostgresUrl({
    readLease: () => readSharedTestPostgresLease(leasePath),
    isAlive: processIsAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.env[SHARED_TEST_POSTGRES_URL] = url;
  return teardownAfterVerifying(url, releaseLock);
}
