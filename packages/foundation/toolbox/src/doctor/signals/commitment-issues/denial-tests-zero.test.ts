/** Proves `denial-tests-zero` counts top-level `tests/` and `assembly/` denial tests referencing a domain. */

import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { denialTestsZeroSignal } from "./denial-tests-zero.js";

function contextWith(files: Readonly<Record<string, string>>, packages: readonly DoctorPackage[]): DoctorContext {
  return {
    root: "/app",
    today: undefined,
    files: () => Object.keys(files),
    directories: () => [],
    read: (path) => files[path] ?? "",
    exists: (path) => path in files,
    packages: () => packages,
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

describe("denial-tests-zero signal", () => {
  it("counts integration denial tests in top-level tests/ and assembly/ that reference the domain", async () => {
    const context = contextWith(
      {
        "dads.project.json": "{}",
        "domains/notes/server/routes.ts": `
          import { getRoute, requireSession } from "@dads-framework/http";
          export const routes = [getRoute({ path: "/notes/:id", access: requireSession(), handler: () => ({}) })];
        `,
        "domains/tenants/server/routes.ts": `
          import { getRoute, requireSession } from "@dads-framework/http";
          export const routes = [getRoute({ path: "/tenants/:id", access: requireSession(), handler: () => ({}) })];
        `,
        "domains/billing/server/routes.ts": `
          import { getRoute, requireSession } from "@dads-framework/http";
          export const routes = [getRoute({ path: "/billing/:id", access: requireSession(), handler: () => ({}) })];
        `,
        "tests/notes.integration.test.ts": `
          test("denies access to notes when caller lacks membership", async () => {});
        `,
        "assembly/tenants-route.test.ts": `
          test("returns forbidden for tenants without manage permission", async () => {});
        `,
      },
      [
        { name: "domains-notes", root: "domains/notes", kind: "core", allowedDependencies: [] },
        { name: "domains-tenants", root: "domains/tenants", kind: "core", allowedDependencies: [] },
        { name: "domains-billing", root: "domains/billing", kind: "core", allowedDependencies: [] },
      ],
    );

    const readings = await denialTestsZeroSignal.run(context);
    expect(readings.get("domains-notes")?.value).toBe(0);
    expect(readings.get("domains-tenants")?.value).toBe(0);
    expect(readings.get("domains-billing")?.value).toBe(1);
  });
});
