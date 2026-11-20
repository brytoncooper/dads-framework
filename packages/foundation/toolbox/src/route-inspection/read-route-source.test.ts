import { expect, test } from "vitest";
import { readRouteSource } from "./read-route-source.js";

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
  expect(routes.map(({ explicitlyPublic }) => explicitlyPublic)).toEqual([
    true,
    undefined,
  ]);

  const [shadowed] = readRouteSource(
    `import { publicAccess } from "@dads-framework/http";
      function register(publicAccess) {
        return getRoute({ path: "/private", access: publicAccess() });
      }`,
    "private.routes.ts",
  );
  expect(shadowed?.explicitlyPublic).toBeUndefined();
});
