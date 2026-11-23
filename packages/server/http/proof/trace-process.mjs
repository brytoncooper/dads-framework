import process from "node:process";

import { startTelemetry } from "../dist/telemetry/index.js";

const telemetry = await startTelemetry({ serviceName: "test-api" });
if (telemetry === undefined) {
  process.stdout.write("telemetry disabled\n");
} else {
  const { runRequest } = await import("./trace-server.mjs");
  try {
    await runRequest(telemetry);
  } finally {
    await telemetry.shutdown();
  }
}
