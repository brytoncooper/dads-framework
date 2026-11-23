import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { traceAttributionCases } from "./core/testing/index.js";

const traceProcess = fileURLToPath(
  new URL("../../proof/trace-process.mjs", import.meta.url),
);

function launchTraceProcess(env: NodeJS.ProcessEnv) {
  return promisify(execFile)(process.execPath, [traceProcess], {
    env: { PATH: process.env["PATH"], ...env },
    timeout: 15_000,
  });
}

it("starts no SDK when the host has no OTLP endpoint", async () => {
  const result = await launchTraceProcess({});
  expect(result.stdout.trim()).toBe("telemetry disabled");
});

it.each([{ OTEL_SDK_DISABLED: "true" }, { OTEL_TRACES_EXPORTER: "none" }])(
  "honors disable settings even with a collector endpoint",
  async (disabled) => {
    const result = await launchTraceProcess({
      ...disabled,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    });
    expect(result.stdout.trim()).toBe("telemetry disabled");
  },
);

it("refuses a malformed explicit endpoint without exposing its value", async () => {
  await expect(
    launchTraceProcess({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "invalid-secret-endpoint",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    }),
  ).rejects.toThrow("The OTLP endpoint must be an HTTP or HTTPS URL.");
});

it.each(traceAttributionCases)(
  "flushes a real OTLP trace for $name",
  async ({ facts, attributes }) => {
    const payloads: Buffer[] = [];
    const collector = createServer((request, response) => {
      expect(request.url).toBe("/v1/traces");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        payloads.push(Buffer.concat(chunks));
        response
          .writeHead(200, { "content-type": "application/x-protobuf" })
          .end();
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );

    try {
      const address = collector.address();
      if (address === null || typeof address === "string") {
        throw new Error("OTLP receiver did not open a TCP socket.");
      }
      await launchTraceProcess({
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=trace-test",
        DADS_TELEMETRY_TEST_REQUEST_ID: facts.requestId,
      });
      const exported = Buffer.concat(payloads).toString("utf8");
      expect(exported).toContain("test-api");
      for (const [key, value] of Object.entries(attributes)) {
        expect(exported).toContain(key);
        expect(exported).toContain(value);
      }
      if (attributes["dads.request.id"] === undefined) {
        expect(exported).not.toContain("dads.request.id");
        expect(exported).not.toContain(facts.requestId);
      }
      expect(exported).toContain("trace-test");
      expect(exported).not.toContain("opaque-user-id");
      expect(exported).not.toContain("sensitive-");
    } finally {
      collector.close();
    }
  },
  20_000,
);
