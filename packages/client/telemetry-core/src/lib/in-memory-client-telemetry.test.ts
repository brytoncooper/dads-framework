import { describe, it } from "vitest";

import { clientTelemetryConformance } from "./client-telemetry-conformance.js";
import { FakeClientTelemetry } from "./in-memory-client-telemetry.js";

describe("ClientTelemetry conformance against the in-memory reporter", () => {
  it.each(clientTelemetryConformance)("$name", async ({ run }) => {
    const telemetry = new FakeClientTelemetry();
    await run({
      telemetry,
      reportedErrors: () => telemetry.reported.map(({ error }) => error),
      breadcrumbs: () => telemetry.breadcrumbs,
    });
  });
});
