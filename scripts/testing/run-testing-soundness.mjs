/** Repository entry point with defaults for the host engine and receipt. */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { buildTestingHostBinary } from "./build-testing-host-binary.mjs";
import { soundnessInvocation } from "./testing-soundness-invocation.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = fileURLToPath(new URL("./testing-soundness.mjs", import.meta.url));
const args = soundnessInvocation(process.argv.slice(2), () => buildTestingHostBinary(root));
const result = spawnSync(process.execPath, [runner, ...args], {
  cwd: root,
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
