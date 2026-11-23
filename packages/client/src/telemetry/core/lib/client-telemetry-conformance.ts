import type { ClientTelemetry, TelemetryBreadcrumb } from "./client-telemetry.js";

type ClientTelemetryFixture = {
  readonly telemetry: ClientTelemetry;
  readonly reportedErrors: () => readonly unknown[];
  readonly breadcrumbs: () => readonly TelemetryBreadcrumb[];
};

type ClientTelemetryConformanceCase = {
  readonly name: string;
  readonly run: (fixture: ClientTelemetryFixture) => Promise<void>;
};

export const clientTelemetryConformance: readonly ClientTelemetryConformanceCase[] = [
  {
    name: "reports the fault synchronously and flushes the same fault and breadcrumb",
    async run({ telemetry, reportedErrors, breadcrumbs }) {
      if (!(await telemetry.flush(1_000))) {
        throw new Error("Telemetry flush failed");
      }
      const fault = new Error("Failed to render");
      const crumb: TelemetryBreadcrumb = {
        at: "2026-11-19T03:00:00Z",
        category: "interaction",
        label: "Pressed save",
      };

      telemetry.addBreadcrumb(crumb);
      telemetry.reportError(fault, { kind: "render" });
      if (!(await telemetry.flush(1_000))) {
        throw new Error("Telemetry flush failed");
      }

      const errors = reportedErrors();
      if (errors.length !== 1 || errors[0] !== fault) {
        throw new Error("Telemetry must report exactly the supplied fault");
      }

      assertReportedBreadcrumb(breadcrumbs(), crumb);
    },
  },
];

function assertReportedBreadcrumb(breadcrumbs: readonly TelemetryBreadcrumb[], expected: TelemetryBreadcrumb): void {
  const [actual] = breadcrumbs;
  if (
    breadcrumbs.length !== 1 ||
    actual === undefined ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    actual.at !== expected.at ||
    actual.category !== expected.category ||
    actual.label !== expected.label
  ) {
    throw new Error("Telemetry must report exactly the supplied breadcrumb");
  }
}
