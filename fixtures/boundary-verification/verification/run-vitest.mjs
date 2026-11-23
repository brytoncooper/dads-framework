import { spawnSync } from "node:child_process";
import process from "node:process";

const vitestBin = process.env["DADS_VITEST_BIN"];
if (!vitestBin) {
  process.stderr.write("DADS_VITEST_BIN is required for fixture tests.\n");
  process.exit(2);
}

const completed = spawnSync(process.execPath, [vitestBin, "run", "src/read-document-unit.test.ts", "--root", "."], {
  encoding: "utf8",
  stdio: "pipe",
});
if (completed.status !== 0 || completed.error) {
  process.stderr.write(`${completed.stderr ?? ""}${completed.stdout ?? ""}`);
  process.exit(completed.status ?? 2);
}
