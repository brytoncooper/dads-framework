import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { PostgresRequestLogSink } from "@dads-framework/audit";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { createDiagnosticsReporter } from "@dads-framework/diagnostics";
import { createJobQueue } from "@dads-framework/job-queue";
import { createObjectStorage } from "@dads-framework/object-storage";
import type { PluginScope } from "@dads-framework/plugin";

import { createLocalMail } from "./local-mail.js";
import type { ServiceConfiguration } from "./services.js";

const log = {
  info: (_details: object, message?: string) => {
    logMessage(message);
  },
  warn: (_details: object, message?: string) => {
    logMessage(message);
  },
  error: (_details: object, message?: string) => {
    logMessage(message);
  },
};

export function openLocalServices(
  scope: PluginScope,
  config: ServiceConfiguration,
  database: DrizzleHandle,
) {
  const queue = createJobQueue(
    { driver: "in-process", queueName: "starter" },
    log,
  );
  scope.onDispose(() => queue.close());
  const requestLog = new PostgresRequestLogSink(database, log);
  scope.onDispose(() => requestLog.close());
  const diagnostics = createDiagnosticsReporter({ driver: "log", log });
  const directory = config.fileStorageDirectory;
  const storage =
    directory === undefined
      ? createObjectStorage({ driver: "memory" })
      : createObjectStorage({
          driver: "disk",
          rootDirectory: directory,
          signingKey: () =>
            Promise.resolve(
              createHash("sha256").update(config.secret).digest(),
            ),
          publicPathPrefix: new URL("/api/files", config.baseUrl).href,
          clock: () => new Date(),
          log,
        });
  return {
    queue,
    requestLog,
    checkFiles: () =>
      directory === undefined ? Promise.resolve() : access(directory),
    diagnostics,
    storage,
    prepareFiles: () =>
      directory === undefined
        ? Promise.resolve()
        : mkdir(directory, { recursive: true, mode: 0o700 }).then(
            () => undefined,
          ),
  };
}

export { createLocalMail };

function logMessage(message: string | undefined): void {
  if (message) process.stderr.write(`${message}\n`);
}
