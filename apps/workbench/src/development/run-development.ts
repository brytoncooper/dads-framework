import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { emitZed } from "@dads-framework/access";
import { SpiceDbAuthorization } from "@dads-framework/spicedb-access";
import { createPostgresConnection, type PostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
} from "@dads-framework/postgres-access";
import { workbenchAccessModel, workbenchUser, workbenchWorkspace } from "../access.js";
import { createPostgresWorkbench } from "../create-workbench.js";
import { startComposedWorkbenchServer, startWorkbenchServer } from "../server.js";
import { SqliteWorkbenchStore } from "../storage/sqlite-workbench-store.js";
import { initializePostgresWorkbenchSchema } from "../storage/postgres-workbench-schema.js";
import { readControlRecord, startDevelopmentControl, writeControlRecord } from "./control-server.js";
import { WorkbenchDevelopmentError } from "./development-error.js";
import { WorkbenchInfrastructure } from "./docker-infrastructure.js";
import { requestDevelopmentStop } from "./request-stop.js";
import {
  acquireDevelopmentLease,
  markDevelopmentInitialized,
  prepareDevelopmentDirectory,
  prepareWorkbenchDatabase,
  readOrCreateDevelopmentState,
  resolveDevelopmentAdapter,
  type DevelopmentArguments,
  type DevelopmentState,
} from "./local-state.js";

type DevelopmentOptions = {
  readonly root: string;
  readonly arguments: DevelopmentArguments;
  readonly signal: AbortSignal;
  readonly requestStop: () => void;
  readonly report: (message: string) => void;
};

/** Everything one launcher opened, recorded as it opens so shutdown can close exactly that. */
type RunningDevelopment = {
  infrastructure?: WorkbenchInfrastructure;
  control?: Awaited<ReturnType<typeof startDevelopmentControl>>;
  store?: SqliteWorkbenchStore;
  postgres?: PostgresConnection;
  server?: Awaited<ReturnType<typeof startWorkbenchServer>>;
};

type WorkbenchConnection = Awaited<ReturnType<WorkbenchInfrastructure["start"]>>;

/** Owns one workbench instance from setup through graceful shutdown, never UI or domain policy. */
export async function runWorkbenchDevelopment(options: DevelopmentOptions): Promise<void> {
  options.signal.throwIfAborted();
  const directory = prepareDevelopmentDirectory(options.root, options.arguments.instance);
  if (options.arguments.action === "stop") {
    await stopDevelopment(options, directory);
    return;
  }
  const lease = acquireDevelopmentLease(directory);
  const running: RunningDevelopment = {};
  const failures: unknown[] = [];
  try {
    await startDevelopment(options, directory, running);
    await untilAborted(options.signal);
  } catch (error) {
    if (!options.signal.aborted) failures.push(error);
  } finally {
    await releaseDevelopment(running, directory, lease, failures);
  }
  finishDevelopment(options, failures);
}

/** Brings up infrastructure and the API, recording each resource in `running` as it opens. */
async function startDevelopment(
  options: DevelopmentOptions,
  directory: string,
  running: RunningDevelopment,
): Promise<void> {
  const state = readOrCreateDevelopmentState(directory, options.arguments.adapter ?? "postgres");
  const adapter = resolveDevelopmentAdapter(state, options.arguments.adapter);
  const infrastructure = infrastructureFor(options.root, directory, state);
  running.infrastructure = infrastructure;
  running.control = await startDevelopmentControl(options.requestStop);
  writeControlRecord(directory, running.control);
  options.report("Starting isolated workbench services; missing project images may be downloaded.");
  const connection = await infrastructure.start(options.signal);
  running.server =
    adapter === "postgres"
      ? await startPostgresApi(options, connection, running)
      : await startSpiceDbApi(options, connection, running, state, directory);
  markDevelopmentInitialized(directory);
  reportReady(options, running.server.url);
}

/** The default backend: application state and authorization tuples in one Postgres. */
async function startPostgresApi(
  options: DevelopmentOptions,
  connection: WorkbenchConnection,
  running: RunningDevelopment,
) {
  if (connection.adapter !== "postgres")
    throw new Error("Workbench Postgres infrastructure returned the wrong backend.");
  const database = createPostgresConnection(
    { schema: {}, connectionString: connection.connectionString },
    {
      error: () => {
        options.report("Workbench Postgres connection failed.");
      },
    },
  );
  running.postgres = database;
  await database.pool.query(relationshipSchemaMigration.sql);
  const namespace = "workbench";
  const authorization = new PostgresAuthorization({
    model: workbenchAccessModel,
    namespace,
    executor: preparePostgresChecks(database.pool),
  });
  await initializePostgresWorkbenchSchema(database.drizzle, namespace);
  const workbench = createPostgresWorkbench({
    database: database.drizzle,
    authorization,
    namespace,
    clock: () => new Date().toISOString(),
    createId: randomUUID,
  });
  return startComposedWorkbenchServer({
    workbench,
    port: options.arguments.port,
  });
}

/** Local SQLite state beside an external SpiceDB. */
async function startSpiceDbApi(
  options: DevelopmentOptions,
  connection: WorkbenchConnection,
  running: RunningDevelopment,
  state: DevelopmentState,
  directory: string,
) {
  if (connection.adapter !== "spicedb") throw new Error("Workbench SpiceDB infrastructure returned the wrong backend.");
  const databasePath = prepareWorkbenchDatabase(directory, state.initialized);
  const authorization = new SpiceDbAuthorization({
    endpoint: connection.endpoint,
    presharedKey: state.token,
    insecure: true,
    consistency: "fully-consistent",
  });
  await waitForAuthorization(authorization, options.signal);
  options.signal.throwIfAborted();
  const store = new SqliteWorkbenchStore(databasePath);
  running.store = store;
  return startWorkbenchServer({
    store,
    authorization,
    port: options.arguments.port,
  });
}

function reportReady(options: DevelopmentOptions, url: string): void {
  options.report(`Workbench API ready: ${url}`);
  options.report(`OpenAPI: ${url}/api/openapi.json`);
  options.report(`Local instance: ${options.arguments.instance}. Ctrl+C stops services; data is retained.`);
  options.report("Browser UI and source watching are not available yet.");
}

/** Closes every opened resource in reverse order; one failure never skips the rest. */
async function releaseDevelopment(
  running: RunningDevelopment,
  directory: string,
  lease: ReturnType<typeof acquireDevelopmentLease>,
  failures: unknown[],
): Promise<void> {
  await cleanup(() => running.server?.stop(), failures);
  await cleanup(() => running.store?.close(), failures);
  await cleanup(() => running.postgres?.close(), failures);
  await cleanup(() => running.infrastructure?.stop(), failures);
  await cleanup(() => running.control?.close(), failures);
  const controlKey = running.control?.key;
  if (controlKey)
    await cleanup(() => {
      removeControlRecord(directory, controlKey);
    }, failures);
  await cleanup(() => {
    lease.close();
  }, failures);
}

/** Reports a clean stop, or raises exactly what failed during startup or shutdown. */
function finishDevelopment(options: DevelopmentOptions, failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Workbench startup or shutdown failed. Data was preserved; retry workbench:stop.",
    );
  options.report("Workbench stopped. Local data and authorization volume were preserved.");
}

async function stopDevelopment(options: DevelopmentOptions, directory: string): Promise<void> {
  let lease: ReturnType<typeof acquireDevelopmentLease>;
  try {
    lease = acquireDevelopmentLease(directory);
  } catch (error) {
    if (!(error instanceof WorkbenchDevelopmentError) || error.code !== "ALREADY_RUNNING") throw error;
    lease = await requestRunningStop(directory, options.signal);
  }
  try {
    if (existsSync(join(directory, "state.json"))) await infrastructureFor(options.root, directory).stop();
    options.report("Workbench stopped. Owned services stopped; local data retained.");
  } finally {
    lease.close();
  }
}

function infrastructureFor(
  root: string,
  directory: string,
  state: DevelopmentState = readOrCreateDevelopmentState(directory),
) {
  return new WorkbenchInfrastructure({
    projectName: `dads-workbench-${state.id}`,
    password: state.password,
    token: state.token,
    adapter: state.adapter,
    composeFile: join(root, "apps/workbench/development/compose.yaml"),
    requireExistingData: state.initialized,
  });
}

async function waitForAuthorization(authorization: SpiceDbAuthorization, signal: AbortSignal) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      // This dedicated local datastore belongs exclusively to this workbench instance.
      await authorization.writeSchema(emitZed(workbenchAccessModel));
      if (
        await authorization.check({
          subject: { type: workbenchUser.wireName, id: "local-readiness" },
          permission: workbenchWorkspace.permissions.view.permissionName,
          resource: {
            type: workbenchWorkspace.wireName,
            id: "local-readiness",
          },
        })
      )
        throw new Error("Readiness subject unexpectedly has access.");
      return;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 14) throw error;
      await setTimeout(250, undefined, { signal });
    }
  }
  throw new Error("Workbench authorization did not become ready within 60 seconds.");
}

async function requestRunningStop(directory: string, signal: AbortSignal) {
  const deadline = Date.now() + 45_000;
  let requested = false;
  while (Date.now() < deadline) {
    if (!requested) signal.throwIfAborted();
    // The live lease, not a PID or stale control file, is authoritative.
    const lease = tryAcquireLease(directory);
    if (lease) return lease;
    if (!requested && existsSync(join(directory, "control.json"))) requested = await sendStopRequest(directory, signal);
    // Once acknowledged, wait for owned cleanup even if the stop caller cancels.
    await waitBetweenStopAttempts(requested, signal);
  }
  throw new Error(
    "Workbench did not stop within 45 seconds. Check its running terminal; no process was forcibly killed.",
  );
}

/** The lease, or undefined while another launcher still holds it. */
function tryAcquireLease(directory: string) {
  try {
    return acquireDevelopmentLease(directory);
  } catch (error) {
    if (!(error instanceof WorkbenchDevelopmentError) || error.code !== "ALREADY_RUNNING") throw error;
    return undefined;
  }
}

/** True once the running instance acknowledged the shutdown over its control channel. */
async function sendStopRequest(directory: string, signal: AbortSignal): Promise<boolean> {
  const control = readControlRecord(directory);
  try {
    await requestDevelopmentStop(control, signal);
    return true;
  } catch {
    signal.throwIfAborted();
    /* Startup may still be replacing a stale control record. */
    return false;
  }
}

/** Polls once. Before a stop is acknowledged the caller may still cancel the wait. */
async function waitBetweenStopAttempts(requested: boolean, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(200, undefined, requested ? undefined : { signal });
  } catch (error) {
    if (!requested) signal.throwIfAborted();
    throw error;
  }
}

function removeControlRecord(directory: string, key: string): void {
  const path = join(directory, "control.json");
  if (existsSync(path) && readControlRecord(directory).key === key) unlinkSync(path);
}

function untilAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
}

async function cleanup(action: () => void | Promise<void>, failures: unknown[]) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}
