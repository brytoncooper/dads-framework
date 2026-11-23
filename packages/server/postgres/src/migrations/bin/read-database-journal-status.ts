#!/usr/bin/env node
import { inspectNodePgMigrations } from "../index.js";
import { migrationInputFromEnvironment } from "./migration-log.js";
import { migrationStatusFailure } from "./read-database-journal-status-result.js";

/** `dads-migrate-status`: prints `current`, a pending state, or a refusal. */
async function printJournalStatus(): Promise<void> {
  try {
    const status = await inspectNodePgMigrations(
      migrationInputFromEnvironment(process.env),
    );
    process.stdout.write(`${status}\n`);
  } catch (error: unknown) {
    const status = migrationStatusFailure(error);
    if (status === undefined) process.exitCode = 1;
    else process.stdout.write(`${status}\n`);
  }
}

void printJournalStatus();
