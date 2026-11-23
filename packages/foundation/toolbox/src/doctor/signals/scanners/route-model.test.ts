import { describe, expect, it } from "vitest";
import type { DoctorContext, DoctorPackage } from "../../doctor-context.js";
import { responsesOutsideEnvelopeSignal } from "../avoidant-attachment/responses-outside-envelope.js";
import { routesWithoutAccessSignal } from "../avoidant-attachment/routes-without-access.js";
import { routesWithoutSchemaSignal } from "../avoidant-attachment/routes-without-schema.js";
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

  it("scans imported *Operation routes, defineRawRoute, and sseRoute without false schema/envelope flags", async () => {
    const context = createAppContext(
      {
        "dads.project.json": "{}",
        "domains/notes/contract/wire.ts": `
import { postOperation } from "@dads-framework/core/contract";
export const createNoteOp = postOperation({
  path: "/tenants/:tenantId/notes",
  params: tenantParams,
  body: noteInput,
  response: noteSchema,
});
`,
        "domains/notes/server/routes.ts": `
import { postRoute, defineRawRoute, sseRoute, requireSession } from "@dads-framework/http";
import { createNoteOp } from "../contract/wire.js";

export const routes = [
  postRoute({
    operation: createNoteOp,
    access: requireSession(),
    handler: async () => ({ id: "1" }),
  }),
  defineRawRoute({
    method: "GET",
    path: "/tenants/:tenantId/notes/export",
    access: requireSession(),
    openapi: {},
    handler: async ({ reply }) => {
      await reply.send("ok");
    },
  }),
  sseRoute({
    path: "/tenants/:tenantId/notes/stream",
    openapi: {},
    handler: async ({ open }) => {
      open(() => () => {});
    },
  }),
];
`,
      },
      [
        {
          name: "domains-notes",
          root: "domains/notes",
          kind: "core",
          allowedDependencies: ["@dads-framework/http"],
        },
      ],
    );

    const model = readRouteModel(context);
    expect(model.operations.map((op) => op.operation)).toEqual([
      "POST /tenants/:tenantId/notes",
      "GET /tenants/:tenantId/notes/export",
      "GET /tenants/:tenantId/notes/stream",
    ]);

    const accessReadings = await routesWithoutAccessSignal.run(context);
    expect(accessReadings.get("domains/notes/server/routes.ts:POST /tenants/:tenantId/notes")?.value).toBe(0);
    expect(accessReadings.get("domains/notes/server/routes.ts:GET /tenants/:tenantId/notes/export")?.value).toBe(0);
    expect(accessReadings.get("domains/notes/server/routes.ts:GET /tenants/:tenantId/notes/stream")?.value).toBe(1);

    const schemaReadings = await routesWithoutSchemaSignal.run(context);
    expect([...schemaReadings.values()].every((reading) => reading.value === 0)).toBe(true);

    const envelopeReadings = await responsesOutsideEnvelopeSignal.run(context);
    expect([...envelopeReadings.values()].every((reading) => reading.value === 0)).toBe(true);
  });
});
