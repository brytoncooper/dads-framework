/** Proves `mutations-without-ownership` recognizes real Dads ownership write patterns. */

import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { mutationsWithoutOwnershipSignal } from "./mutations-without-ownership.js";

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

describe("mutations-without-ownership signal", () => {
  it("recognizes writeWithPermission, writeRelationships, withProtectedDrizzleTransaction, columnRelations, and tenants.create", async () => {
    const context = contextWith(
      {
        "dads.project.json": "{}",
        "domains/notes/server/routes.ts": `
          import { postRoute } from "@dads-framework/http";
          export const routes = [
            postRoute({
              path: "/notes",
              access: notesAccess,
              handler: () => writeWithPermission({ subject, permission, resourceId }, (tx) => tx),
            }),
          ];
        `,
        "domains/tenants/server/routes.ts": `
          import { postRoute } from "@dads-framework/http";
          export const routes = [
            postRoute({
              path: "/tenants",
              access: { kind: "session" },
              handler: ({ body, subject }) => tenants.create(subject.id, body.name),
            }),
          ];
        `,
        "domains/items/server/routes.ts": `
          import { postRoute } from "@dads-framework/http";
          export const routes = [
            postRoute({
              path: "/items",
              access: itemsAccess,
              handler: () => insertUnownedItem(),
            }),
          ];
        `,
      },
      [
        { name: "domains-notes", root: "domains/notes", kind: "core", allowedDependencies: [] },
        { name: "domains-tenants", root: "domains/tenants", kind: "core", allowedDependencies: [] },
        { name: "domains-items", root: "domains/items", kind: "core", allowedDependencies: [] },
      ],
    );

    const readings = await mutationsWithoutOwnershipSignal.run(context);
    expect(readings.get("domains/notes/server/routes.ts:POST /notes")?.value).toBe(0);
    expect(readings.get("domains/tenants/server/routes.ts:POST /tenants")?.value).toBe(0);
    expect(readings.get("domains/items/server/routes.ts:POST /items")?.value).toBe(1);
  });
});
