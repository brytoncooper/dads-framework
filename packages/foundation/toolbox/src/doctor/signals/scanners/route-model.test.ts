import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { routesWithoutAccessSignal } from "../avoidant-attachment/routes-without-access.js";
import { readRouteModel } from "./route-model.js";

function createAppContext(files: Readonly<Record<string, string>>, packages: readonly DoctorPackage[]): DoctorContext {
  const paths = Object.keys(files);
  return {
    root: "/app",
    today: undefined,
    files: () => paths,
    directories: () => [],
    read: (path) => files[path] ?? "",
    exists: (path) => path in files,
    packages: () => packages,
    exec: () => ({ status: 1, stdout: "" }),
    online: false,
    fetch: () => {
      throw new Error("no network in unit tests");
    },
    program: () => {
      throw new Error("no ts program needed for route-model unit test");
    },
  };
}

describe("readRouteModel on canonical application layouts (without src/)", () => {
  it("scans routes under domains/<name>/server/ and flags missing access declarations", async () => {
    const context = createAppContext(
      {
        "dads.project.json": "{}",
        "domains/tasks/server/routes.ts": `
import { getRoute, postRoute, requireSession } from "@dads-framework/http";

export const routes = [
  getRoute({
    path: "/tasks/:id",
    access: requireSession(),
    handler: async () => ({ ok: true }),
  }),
  postRoute({
    path: "/tasks",
    handler: async () => ({ ok: true }),
  }),
];
`,
      },
      [
        {
          name: "domains-tasks",
          root: "domains/tasks",
          kind: "core",
          allowedDependencies: ["@dads-framework/http"],
        },
      ],
    );

    const model = readRouteModel(context);
    expect(model.operations).toHaveLength(2);
    expect(model.packagesWithRoutes.map((pkg) => pkg.name)).toEqual(["domains-tasks"]);

    const readings = await routesWithoutAccessSignal.run(context);
    expect([...readings.entries()].map(([key, reading]) => [key, reading.value])).toEqual([
      ["domains/tasks/server/routes.ts:GET /tasks/:id", 0],
      ["domains/tasks/server/routes.ts:POST /tasks", 1],
    ]);
  });
});
