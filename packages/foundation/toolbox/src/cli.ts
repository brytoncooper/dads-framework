#!/usr/bin/env node

import { helpFor, usage } from "../bin/usage.js";
import { installBrokenPipeHandler, isBrokenPipeError } from "./cli-io.js";

installBrokenPipeHandler();

const args = process.argv.slice(2);
const [command, subject, detail] = args;
const wantsJson = args.includes("--json");
const help = helpFor(args);

try {
  if (help !== undefined) {
    process.stdout.write(`${help}\n`);
  } else if (command === "baseline") {
    const { baselineCommand } = await import("./cli-baseline-commands.js");
    process.exitCode = await baselineCommand(args.slice(1));
  } else if (command === "doctor") {
    const { doctor } = await import("./cli-doctor-commands.js");
    process.exitCode = await doctor(args.slice(1), wantsJson);
  } else if (command === "orient" || command === "explain") {
    const { orient } = await import("./cli-inspection-commands.js");
    orient(subject, wantsJson);
  } else if (command === "inspect") {
    const { inspect } = await import("./cli-route-inspection-commands.js");
    inspect(subject, detail, wantsJson);
  } else if (command === "test:recommend") {
    const { recommendTests } = await import("./cli-inspection-commands.js");
    recommendTests(args, wantsJson);
  } else if (command === "test") {
    const { runDadTestCli } = await import("@dads-framework/testing");
    process.exitCode = await runDadTestCli(args.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    });
  } else if (command === "verify") {
    const { verifyChanged } = await import("./cli-inspection-commands.js");
    verifyChanged(args, wantsJson);
  } else if (command === "skills:sync") {
    const { synchronize } = await import("./cli-inspection-commands.js");
    synchronize(wantsJson);
  } else if (command === "init") {
    const { initialize } = await import("./cli-project-commands.js");
    initialize(args.slice(1), wantsJson);
  } else if (command === "add" && subject === "library") {
    const { addLibrary } = await import("./cli-library-commands.js");
    addLibrary(args.slice(2), wantsJson);
  } else if (command === "add") {
    const { addProjectArtifact } = await import("./cli-generator-commands.js");
    addProjectArtifact(args.slice(1), wantsJson);
  } else if (command === "access") {
    const { accessCommand } = await import("./cli-access-commands.js");
    await accessCommand(args.slice(1), wantsJson);
  } else if (command === "db") {
    const { dbCommand } = await import("./cli-db-commands.js");
    process.exitCode = await dbCommand(args.slice(1));
  } else if (command === "check" && subject === "boundaries") {
    const { checkBoundaries } = await import("./cli-boundary-commands.js");
    checkBoundaries(args.slice(2), wantsJson);
  } else if (command === "migrate") {
    const { migrateCommand } = await import("./cli-migrate-commands.js");
    migrateCommand(args.slice(1), wantsJson);
  } else {
    throw new Error(usage);
  }
} catch (error: unknown) {
  if (isBrokenPipeError(error)) {
    process.exitCode = 0;
  } else {
    const message = error instanceof Error ? error.message : "Unknown failure.";
    if (wantsJson) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`Dad: ${message}\n`);
    }
    process.exitCode = 1;
  }
}
