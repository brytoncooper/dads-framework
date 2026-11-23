/** Proves `test-count` reports missing or invalid Vitest reports as not measured instead of zero. */

import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../../doctor-context.js";
import { testCountSignal } from "./test-count.js";

function contextWithReport(report: string | undefined): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => ["packages/demo/package.json"],
    directories: () => [],
    read: (path) => {
      if (path === "packages/demo/package.json") {
        return JSON.stringify({ name: "@fixture/demo" });
      }
      return report ?? "";
    },
    exists: (path) => path === "node_modules/.dads/vitest-report.json" && report !== undefined,
    packages: () => [],
    exec: () => ({ status: 1, stdout: "" }),
    online: false,
    fetch: () => {
      throw new Error("no network here");
    },
    program: () => {
      throw new Error("no program here");
    },
  };
}

describe("test-count signal", () => {
  it("throws when the Vitest report is missing so doctor marks it not measured", () => {
    expect(() => testCountSignal.run(contextWithReport(undefined))).toThrow("run npm test first");
  });

  it("throws when the Vitest report has no testResults array", () => {
    expect(() => testCountSignal.run(contextWithReport("{}"))).toThrow("invalid test report");
  });

  it("counts passed and failed assertions while excluding skipped tests", async () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: "/repo/packages/demo/src/a.test.ts",
          assertionResults: [{ status: "passed" }, { status: "failed" }, { status: "skipped" }],
        },
      ],
    });
    const readings = await testCountSignal.run(contextWithReport(report));

    expect(readings.get("@fixture/demo")?.value).toBe(2);
  });

  it("maps tests to dads.project.json packages and root package.json in single-package apps", async () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: "/app/domains/notes/pure/note-rules.test.ts",
          assertionResults: [{ status: "passed" }, { status: "passed" }],
        },
        {
          name: "/app/assembly/scim-binding-route.test.ts",
          assertionResults: [{ status: "passed" }],
        },
        {
          name: "/app/tests/starter.integration.test.ts",
          assertionResults: [{ status: "passed" }, { status: "passed" }, { status: "passed" }],
        },
      ],
    });
    const context: DoctorContext = {
      root: "/app",
      today: undefined,
      files: () => ["package.json", "dads.project.json"],
      directories: () => [],
      read: (path) => {
        if (path === "package.json") return JSON.stringify({ name: "my-dads-app" });
        return report;
      },
      exists: (path) => path === "node_modules/.dads/vitest-report.json" || path === "package.json",
      packages: () => [
        { name: "domains-notes", root: "domains/notes", kind: "core", allowedDependencies: [] },
        { name: "assembly", root: "assembly", kind: "binding", allowedDependencies: [] },
      ],
      exec: () => ({ status: 1, stdout: "" }),
      online: false,
      fetch: () => {
        throw new Error("no network here");
      },
      program: () => {
        throw new Error("no program here");
      },
    };

    const readings = await testCountSignal.run(context);
    expect(readings.get("domains-notes")?.value).toBe(2);
    expect(readings.get("assembly")?.value).toBe(1);
    expect(readings.get("my-dads-app")?.value).toBe(3);
  });
});
