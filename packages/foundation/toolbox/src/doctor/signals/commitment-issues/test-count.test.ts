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
});
