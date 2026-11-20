import { spawnSync } from "node:child_process";
import process from "node:process";

const typescriptBin = process.env["DADS_TYPESCRIPT_BIN"];
if (!typescriptBin) {
  process.stderr.write(
    "DADS_TYPESCRIPT_BIN is required for fixture type tests.\n",
  );
  process.exit(2);
}

const completed = spawnSync(
  process.execPath,
  [typescriptBin, "-p", "type-tests/tsconfig.json", "--pretty", "false"],
  { encoding: "utf8", stdio: "pipe" },
);
if (completed.status !== 0 || completed.error) {
  process.stderr.write(`${completed.stderr ?? ""}${completed.stdout ?? ""}`);
  process.exit(completed.status ?? 2);
}
