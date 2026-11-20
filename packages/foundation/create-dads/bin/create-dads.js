#!/usr/bin/env node

import { existsSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const entrypoint = new URL("../dist/cli.js", import.meta.url);
if (existsSync(entrypoint)) {
  await import(entrypoint.href);
} else {
  process.stderr.write(
    "Dads: CLI build files are missing. Run npm run build:cli in the source workspace, or reinstall the create-dads package.\n",
  );
  process.exitCode = 1;
}
