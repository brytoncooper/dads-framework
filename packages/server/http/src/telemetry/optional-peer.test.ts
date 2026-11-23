import { describe, expect, it } from "vitest";

import {
  loadOpenTelemetryPeers,
  type OpenTelemetryPeerLoaders,
} from "./node-telemetry.js";
import { loadOptionalPeer } from "./optional-peer.js";

function missingModuleError(
  message: string,
  code?: "ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND",
): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("loadOptionalPeer (http/telemetry)", () => {
  it("wraps ERR_MODULE_NOT_FOUND with subpath, package name, install hint, and cause", async () => {
    const cause = missingModuleError(
      "Cannot find package '@opentelemetry/sdk-node'",
      "ERR_MODULE_NOT_FOUND",
    );

    const error = await loadOptionalPeer(
      "@dads-framework/http/telemetry",
      "@opentelemetry/sdk-node",
      () => Promise.reject(cause),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected Error");
    expect(error.message).toBe(
      '@dads-framework/http/telemetry requires optional peer dependency "@opentelemetry/sdk-node". Install it with: npm install @opentelemetry/sdk-node',
    );
    expect(error.cause).toBe(cause);
  });

  it("wraps MODULE_NOT_FOUND and Cannot find module errors", async () => {
    await expect(
      loadOptionalPeer(
        "@dads-framework/http/telemetry",
        "@opentelemetry/api",
        () =>
          Promise.reject(
            missingModuleError(
              "Cannot find module '@opentelemetry/api'",
              "MODULE_NOT_FOUND",
            ),
          ),
      ),
    ).rejects.toThrow(
      '@dads-framework/http/telemetry requires optional peer dependency "@opentelemetry/api". Install it with: npm install @opentelemetry/api',
    );
  });

  it("rethrows unrelated errors unchanged", async () => {
    const bug = new Error("Exporter initialization failed");

    const caught = await loadOptionalPeer(
      "@dads-framework/http/telemetry",
      "@opentelemetry/sdk-node",
      () => Promise.reject(bug),
    ).catch((error: unknown) => error);

    expect(caught).toBe(bug);
  });

  const peerCases: ReadonlyArray<{
    readonly key: keyof OpenTelemetryPeerLoaders;
    readonly packageName: string;
  }> = [
    { key: "loadApi", packageName: "@opentelemetry/api" },
    {
      key: "loadExporter",
      packageName: "@opentelemetry/exporter-trace-otlp-proto",
    },
    {
      key: "loadInstrumentation",
      packageName: "@opentelemetry/instrumentation",
    },
    {
      key: "loadHttpInstrumentation",
      packageName: "@opentelemetry/instrumentation-http",
    },
    {
      key: "loadPgInstrumentation",
      packageName: "@opentelemetry/instrumentation-pg",
    },
    { key: "loadResources", packageName: "@opentelemetry/resources" },
    { key: "loadSdkNode", packageName: "@opentelemetry/sdk-node" },
    { key: "loadSdkTrace", packageName: "@opentelemetry/sdk-trace" },
  ];

  it.each(peerCases)(
    "reports an actionable install error when $packageName is missing",
    async ({ key, packageName }) => {
      const cause = missingModuleError(
        `Cannot find package '${packageName}'`,
        "ERR_MODULE_NOT_FOUND",
      );

      await expect(
        loadOpenTelemetryPeers({ [key]: () => Promise.reject(cause) }),
      ).rejects.toMatchObject({
        message: `@dads-framework/http/telemetry requires optional peer dependency "${packageName}". Install it with: npm install ${packageName}`,
        cause,
      });
    },
  );

  it("rethrows unrelated errors from loadOpenTelemetryPeers unchanged", async () => {
    const unrelated = new RangeError("Bad SDK version");

    await expect(
      loadOpenTelemetryPeers({
        loadSdkNode: () => Promise.reject(unrelated),
      }),
    ).rejects.toBe(unrelated);
  });
});
