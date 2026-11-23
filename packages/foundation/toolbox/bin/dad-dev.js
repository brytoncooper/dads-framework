#!/usr/bin/env node
import process from "node:process";
import { runDevCommand } from "../dist/dev/cli.js";

try {
  process.stdout.write(await runDevCommand(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `dad-dev: ${error instanceof Error ? error.message : "command failed"}\n`,
  );
  process.exitCode = 1;
}
