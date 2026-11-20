import { resolve } from "node:path";

import {
  defaultMigrationWorkspace,
  describeMigrationFailure,
  type MigrationWorkspace,
  parseMigrationEnvironment,
} from "../index.js";

/** One JSON line per event, the shape a log shipper reads without a library. */
export const migrationLog = {
  info(context: object, message: string): void {
    process.stdout.write(
      `${JSON.stringify({ level: "info", ...context, message })}\n`,
    );
  },
  error(context: object, message: string): void {
    process.stderr.write(
      `${JSON.stringify({ level: "error", ...context, message })}\n`,
    );
  },
};

/** `DATABASE_URL` and `WORKSPACE_ROOT`, read into the runner's input. */
export function migrationInputFromEnvironment(environment: NodeJS.ProcessEnv): {
  databaseUrl: string;
  workspace: MigrationWorkspace;
} {
  const parsed = parseMigrationEnvironment(environment);
  return {
    databaseUrl: parsed.databaseUrl,
    workspace: defaultMigrationWorkspace(resolve(parsed.workspaceRoot)),
  };
}

/** Logs a failed command with its classified cause and sets exit code 1. */
export function reportMigrationFailure(
  error: unknown,
  failure: { event: string; code: string; message: string },
): void {
  migrationLog.error(
    {
      event: failure.event,
      code: failure.code,
      cause: describeMigrationFailure(error),
      detail: error instanceof Error ? error.message : String(error),
    },
    failure.message,
  );
  process.exitCode = 1;
}
