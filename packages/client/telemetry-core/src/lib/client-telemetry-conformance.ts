import { deepEqual, equal } from "node:assert/strict";
import type {
  ClientTelemetry,
  TelemetryBreadcrumb,
} from "./client-telemetry.js";

type ClientTelemetryFixture = {
  readonly telemetry: ClientTelemetry;
  readonly reportedErrors: () => readonly unknown[];
  readonly breadcrumbs: () => readonly TelemetryBreadcrumb[];
};

type ClientTelemetryConformanceCase = {
  readonly name: string;
  readonly run: (fixture: ClientTelemetryFixture) => Promise<void>;
};

export const clientTelemetryConformance: readonly ClientTelemetryConformanceCase[] =
  [
    {
      name: "reports the fault synchronously and flushes the same fault and breadcrumb",
      async run({ telemetry, reportedErrors, breadcrumbs }) {
        equal(await telemetry.flush(1_000), true);
        const fault = new Error("Failed to render");
        const crumb: TelemetryBreadcrumb = {
          at: "2026-11-19T03:00:00Z",
          category: "interaction",
          label: "Pressed save",
        };

        telemetry.addBreadcrumb(crumb);
        telemetry.reportError(fault, { kind: "render" });
        equal(await telemetry.flush(1_000), true);

        deepEqual(reportedErrors(), [fault]);
        deepEqual(breadcrumbs(), [crumb]);
      },
    },
  ];
