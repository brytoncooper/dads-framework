import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspect } from "../cli-route-inspection-commands.js";
import { readRouteSource } from "./read-route-source.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads a kit route and its access, schemas, and delegated handler", () => {
  const [route] = readRouteSource(
    `const product = getRoute({
      route: { method: "GET", template: "/products/:id" },
      access: { kind: "public" },
      params: productParams,
      response: productSchema,
      handler: ({ params }) => readProduct(params.id),
    });`,
    "product.routes.ts",
  );
  expect(route).toMatchObject({
    operation: "GET /products/:id",
    method: "GET",
    routePath: "/products/:id",
    line: 1,
    schemas: { params: "productParams", response: "productSchema" },
    declaresAccess: true,
    handlerStatements: 1,
  });
});

test("reads the dad verb API without inferring omitted contract facts", () => {
  const [route] = readRouteSource(
    `const products = dad.list({
      path: "/products",
      item: productSchema,
      handler: () => {
        const data = readProducts();
        return { data, total: data.length };
      },
    });`,
    "products.routes.ts",
  );
  expect(route).toMatchObject({
    operation: "GET /products",
    declaresAccess: false,
    schemas: { item: "productSchema" },
    handlerStatements: 2,
  });
  expect(route?.schemas.query).toBeUndefined();
});

test("only recognizes the imported public route helper as explicit public access", () => {
  const routes = readRouteSource(
    `import { publicAccess as anonymous } from "@dads-framework/http";
      getRoute({ path: "/health", access: anonymous() });
      getRoute({ path: "/private", access: authorize() });`,
    "health.routes.ts",
  );
  expect(routes.map(({ explicitlyPublic }) => explicitlyPublic)).toEqual([true, undefined]);

  const [shadowed] = readRouteSource(
    `import { publicAccess } from "@dads-framework/http";
      function register(publicAccess) {
        return getRoute({ path: "/private", access: publicAccess() });
      }`,
    "private.routes.ts",
  );
  expect(shadowed?.explicitlyPublic).toBeUndefined();
});

test("resolves same-file and imported *Operation contracts, defineRawRoute, and sseRoute", () => {
  const files: Readonly<Record<string, string>> = {
    "domains/notes/contract/index.ts": 'export * from "./wire.js";\n',
    "domains/notes/contract/wire.ts": `
      import { getOperation, listOperation, postOperation, defineOperation } from "@dads-framework/core/contract";
      export const createNoteOp = postOperation({
        path: "/tenants/:tenantId/notes",
        params: tenantParams,
        body: noteInput,
        response: noteSchema,
      });
      export const listNotesOp = listOperation({
        path: "/tenants/:tenantId/notes",
        params: tenantParams,
        query: paginationQuery,
        item: noteSchema,
      });
      export const customOp = defineOperation({
        method: "PATCH",
        path: "/tenants/:tenantId/notes/:noteId",
        params: noteParams,
        body: notePatch,
        response: noteSchema,
      });
      export const exportPath = "/tenants/:tenantId/notes/export";
    `,
  };
  const routesSource = `
    import { postRoute, listRoute, patchRoute, getRoute, defineRawRoute, sseRoute } from "@dads-framework/http";
    import { getOperation } from "@dads-framework/core/contract";
    import { createNoteOp, listNotesOp, customOp, exportPath } from "../contract/index.js";

    const localHealthOp = getOperation({
      path: "/health",
      response: healthSchema,
    });

    export const routes = [
      postRoute({
        operation: createNoteOp,
        access: notesAccess,
        handler: ({ body }) => createNote(body),
      }),
      listRoute({
        operation: listNotesOp,
        access: notesAccess,
        handler: () => listNotes(),
      }),
      patchRoute({
        operation: customOp,
        access: notesAccess,
        handler: () => patchNote(),
      }),
      getRoute({
        operation: localHealthOp,
        access: healthAccess,
        handler: () => readHealth(),
      }),
      defineRawRoute({
        method: "GET",
        path: exportPath,
        access: notesAccess,
        openapi: {},
        handler: async ({ reply }) => { await reply.send("csv"); },
      }),
      sseRoute({
        path: "/tenants/:tenantId/notes/stream",
        access: notesAccess,
        openapi: {},
        handler: async ({ open }) => { open(() => () => {}); },
      }),
    ];
  `;

  const routes = readRouteSource(routesSource, "domains/notes/server/routes.ts", {
    readFile: (path) => files[path],
  });

  expect(routes).toMatchObject([
    {
      operation: "POST /tenants/:tenantId/notes",
      method: "POST",
      routePath: "/tenants/:tenantId/notes",
      schemas: { params: "tenantParams", body: "noteInput", response: "noteSchema" },
      declaresAccess: true,
    },
    {
      operation: "GET /tenants/:tenantId/notes",
      method: "GET",
      routePath: "/tenants/:tenantId/notes",
      schemas: { params: "tenantParams", query: "paginationQuery", item: "noteSchema" },
      declaresAccess: true,
    },
    {
      operation: "PATCH /tenants/:tenantId/notes/:noteId",
      method: "PATCH",
      routePath: "/tenants/:tenantId/notes/:noteId",
      schemas: { params: "noteParams", body: "notePatch", response: "noteSchema" },
      declaresAccess: true,
    },
    {
      operation: "GET /health",
      method: "GET",
      routePath: "/health",
      schemas: { response: "healthSchema" },
      declaresAccess: true,
    },
    {
      operation: "GET /tenants/:tenantId/notes/export",
      method: "GET",
      routePath: "/tenants/:tenantId/notes/export",
      raw: true,
      declaresAccess: true,
    },
    {
      operation: "GET /tenants/:tenantId/notes/stream",
      method: "GET",
      routePath: "/tenants/:tenantId/notes/stream",
      raw: true,
      declaresAccess: true,
    },
  ]);
});

test("dad inspect http-operation finds imported *Operation routes, defineRawRoute, and sseRoute", () => {
  const root = mkdtempSync(join(tmpdir(), "dad-inspect-op-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "domains/things/contract"), { recursive: true });
  mkdirSync(join(root, "domains/things/server"), { recursive: true });
  writeFileSync(join(root, "dads.project.json"), JSON.stringify({ schemaVersion: 1, packages: [] }));
  writeFileSync(
    join(root, "domains/things/contract/wire.ts"),
    `import { postOperation } from "@dads-framework/core/contract";
export const createThingOp = postOperation({
  path: "/things",
  body: thingInput,
  response: thingSchema,
});
`,
  );
  writeFileSync(
    join(root, "domains/things/server/routes.ts"),
    `import { postRoute, defineRawRoute, sseRoute } from "@dads-framework/http";
import { createThingOp } from "../contract/wire.js";

export const routes = [
  postRoute({ operation: createThingOp, access: thingsAccess, handler: () => createThing() }),
  defineRawRoute({ method: "GET", path: "/things/export", access: thingsAccess, openapi: {}, handler: async () => {} }),
  sseRoute({ path: "/things/events", access: thingsAccess, openapi: {}, handler: async () => {} }),
];
`,
  );

  const originalCwd = process.cwd();
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    process.chdir(root);
    inspect("http-operation", "POST /things", true);
    inspect("http-operation", "GET /things/export", true);
    inspect("http-operation", "GET /things/events", true);
  } finally {
    process.chdir(originalCwd);
    stdout.mockRestore();
  }

  const results: readonly unknown[] = chunks
    .join("")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  expect(results[0]).toMatchObject({
    ok: true,
    operations: [
      {
        file: "domains/things/server/routes.ts",
        method: "POST",
        path: "/things",
        schemas: { body: "thingInput", response: "thingSchema" },
        declaresAccess: true,
      },
    ],
  });
  expect(results[1]).toMatchObject({
    ok: true,
    operations: [{ method: "GET", path: "/things/export", declaresAccess: true }],
  });
  expect(results[2]).toMatchObject({
    ok: true,
    operations: [{ method: "GET", path: "/things/events", declaresAccess: true }],
  });
});
