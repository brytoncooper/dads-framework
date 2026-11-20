import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDevelopmentArguments } from "./local-state.js";
import { runWorkbenchDevelopment } from "./run-development.js";
import { describeDevelopmentFailure } from "./describe-development-failure.js";

const cancellation = new AbortController();
const requestStop = () => {
  cancellation.abort();
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
// The bootstrap owns this child. A killed bootstrap must not orphan an API writer.
process.once("disconnect", requestStop);

try {
  const args = parseDevelopmentArguments(process.argv.slice(2));
  if (args.action === "help") {
    process.stdout.write(
      "Workbench: up [--instance name] [--port 0..65535] [--adapter postgres|spicedb], or stop [--instance name].\n",
    );
    process.stdout.write(
      "New instances use Postgres by default; existing instances retain their recorded backend.\n",
    );
  } else {
    await runWorkbenchDevelopment({
      root: fileURLToPath(new URL("../../../../", import.meta.url)),
      arguments: args,
      signal: cancellation.signal,
      requestStop,
      report: (message) => {
        process.stdout.write(`${message}\n`);
      },
    });
  }
} catch (error) {
  // Never print nested causes, subprocess arguments, local state, or credentials.
  const failure = describeDevelopmentFailure(error, cancellation.signal);
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = failure.exitCode;
} finally {
  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  process.removeListener("disconnect", requestStop);
  if (process.connected) process.disconnect();
}
