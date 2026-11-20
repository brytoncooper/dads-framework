#!/usr/bin/env node

import process from "node:process";
import { runDadTestCli } from "./dad-test-cli.js";

process.exitCode = await runDadTestCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});
