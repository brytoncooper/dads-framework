import { describe, expect, it } from "vitest";
import { renderDoctorResult } from "./doctor.js";

describe("renderDoctorResult", () => {
  it("renders a concise ok line when there are no findings", () => {
    const out = renderDoctorResult({
      schemaVersion: 1,
      ok: true,
      counts: {
        projectsChecked: 12,
        testTasksChecked: 15,
        testFilesChecked: 84,
        errors: 0,
        warnings: 0,
        workspaceUncertainties: 0,
      },
      findings: [],
    });
    expect(out).toBe("doctor: ok (12 projects, 15 test tasks, 84 test files, 0 findings).\n");
  });

  it("renders actionable code, location, and fix lines when failing", () => {
    const out = renderDoctorResult({
      schemaVersion: 1,
      ok: false,
      counts: {
        projectsChecked: 2,
        testTasksChecked: 1,
        testFilesChecked: 2,
        errors: 1,
        warnings: 0,
        workspaceUncertainties: 0,
      },
      findings: [
        {
          code: "unowned-test-file",
          severity: "error",
          project: "wire-command-staff-api",
          path: "libs/command/api/wire-command-staff-api/src/filters.integration.test.ts",
          message: "Test file is not matched by any test task.",
          fix: 'Add a "test:integration" target.',
        },
      ],
    });
    expect(out).toContain("doctor: FAILED (1 error(s)");
    expect(out).toContain("[unowned-test-file] wire-command-staff-api");
    expect(out).toContain('fix: Add a "test:integration" target.');
  });
});
