/** Small programs that compile and run against the packed kit boundaries. */

const documentModel = `import { access, accessModel, emitZed, entityHandle } from "@dads-framework/access";
import { z } from "zod";
const idSchema = z.string().min(1);
const user = entityHandle({ wireName: "user", idSchema });
const document = entityHandle({ wireName: "document", idSchema });
const users = access(user, { roles: {}, permissions: () => ({}) });
const documents = access(document, { roles: { reader: user }, permissions: ({ reader }) => ({ view: [reader] }) });
const model = accessModel([users, documents]);
const alice = { type: user.wireName, id: "alice" };
const example = { type: document.wireName, id: "example" };
`;

export function createAdoptionFixtures() {
  return [
    {
      name: "contract",
      packages: ["@dads-framework/contract"],
      source: `import { entityIdSchema, mintEntityId } from "@dads-framework/contract";
import { z } from "zod";
const documentId = entityIdSchema("DocumentId", "Document identifier.");
const title = z.string().trim().min(1).max(20);
const request = z.strictObject({ documentId, title, percent: z.number().min(0).max(100) });
const id = mintEntityId(documentId);
if (documentId.safeParse("invalid").success) throw new Error("UUID validation lost");
if (z.toJSONSchema(documentId).description !== "Document identifier.") throw new Error("Identifier metadata lost");
if (title.parse("  Dads  ") !== "Dads" || title.safeParse(" ").success) throw new Error("Title bounds lost");
if (request.safeParse({ documentId: id, title: "Dads", percent: 101 }).success) throw new Error("Percentage bounds lost");
if (request.safeParse({ documentId: id, title: "Dads", percent: 0, extra: true }).success) throw new Error("Request strictness lost");
`,
    },
    {
      name: "plain-http",
      // The generated app checks its own declarations with Node types and
      // skips unused peer-driver declarations shipped by Drizzle.
      consumerConfig: { skipLibCheck: true },
      vendorTypePackages: ["@types/pg"],
      packages: ["@dads-framework/http"],
      source: `import { getRoute, publicAccess, routeGroup } from "@dads-framework/http";
import { buildTestApp, dataBodyOf } from "@dads-framework/http/testing";
import { z } from "zod";
const response = z.string().min(1).max(20);
const routes = routeGroup("Greeting", [getRoute({
  route: { method: "GET", template: "/greeting" },
  summary: "Get greeting",
  access: publicAccess(),
  response,
  handler: () => "hello",
})]);
const app = await buildTestApp({ routes });
try {
  const result = await app.inject({ method: "GET", url: "/greeting" });
  if (result.statusCode !== 200 || dataBodyOf(result, response) !== "hello") throw new Error("Packed HTTP route did not run");
} finally {
  await app.close();
}
`,
    },
    {
      name: "protected-http",
      // The generated app checks its own declarations with Node types and
      // skips unused peer-driver declarations shipped by Drizzle.
      consumerConfig: { skipLibCheck: true },
      vendorTypePackages: ["@types/pg"],
      packages: [
        "@dads-framework/access",
        "@dads-framework/authorization",
        "@dads-framework/contract",
        "@dads-framework/http",
      ],
      source:
        `import { fromParam, getRoute, requires, routeGroup } from "@dads-framework/http";
import { buildTestApp, TEST_SUBJECT_HEADER } from "@dads-framework/http/testing";
import { FakeAuthorization } from "@dads-framework/authorization/testing";
import { ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE } from "@dads-framework/contract";
` +
        documentModel +
        `if (!emitZed(model).includes("permission view = reader")) throw new Error("Access model projection lost");
const authorization = new FakeAuthorization({ [document.wireName]: { view: ["reader"] } });
const routes = routeGroup("Documents", [getRoute({
  route: { method: "GET", template: "/documents/:id" },
  summary: "Read document",
  access: requires(documents.permissions.view, fromParam("id")),
  params: z.object({ id: idSchema }),
  response: z.object({ id: idSchema }),
  handler: ({ params }) => ({ id: params.id }),
})]);
const app = await buildTestApp({ routes, authorization });
try {
  const request = { method: "GET", url: "/documents/example", headers: { [TEST_SUBJECT_HEADER]: alice.id } } satisfies Parameters<typeof app.inject>[0];
  const denied = await app.inject(request);
  if (denied.statusCode !== 404 || denied.headers[ACCESS_REFUSAL_HEADER] !== ACCESS_REFUSAL_VALUE) throw new Error("HTTP access refusal changed");
  await authorization.writeRelationships([{ resource: example, relation: "reader", subject: alice }]);
  const allowed = await app.inject(request);
  if (allowed.statusCode !== 200) throw new Error("Valid relationship was denied");
} finally {
  await app.close();
}
`,
    },
    {
      name: "postgres-authorization",
      // The generated app checks its own declarations with Node types and
      // skips unused peer-driver declarations shipped by Drizzle.
      consumerConfig: { skipLibCheck: true },
      vendorTypePackages: ["@types/pg"],
      packages: ["@dads-framework/postgres-access"],
      source:
        `import { PostgresAuthorization, relationshipSchemaMigration } from "@dads-framework/postgres-access";
` +
        documentModel +
        `if (!relationshipSchemaMigration.sql.includes("dad_authorization_relationship")) throw new Error("Missing tuple schema");
let checked = false;
const authorization = new PostgresAuthorization({
  model,
  namespace: "adopter",
  executor: { query: ({ text, values }) => {
    if (!text.includes("dad_authorization_relationship") || !values?.includes("adopter")) throw new Error("Tuple query lost scope");
    checked = true;
    return Promise.resolve({ rows: [{ allowed: false }], rowCount: 1 });
  } },
});
if (await authorization.check({ subject: alice, resource: example, permission: "view" }) || !checked) throw new Error("Unrelated document was allowed");
`,
    },
    {
      name: "feature-flag-bindings",
      packages: [
        "@dads-framework/access",
        "@dads-framework/feature-flags",
        "@dads-framework/http",
        "@dads-framework/postgres",
      ],
      consumerConfig: { skipLibCheck: true },
      vendorTypePackages: ["@types/pg", "node-pg-migrate@^9.0.0"],
      source: `import { createFeatureFlagRoutes } from "@dads-framework/feature-flags/http";
import { DrizzleFeatureFlagStore, installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags/postgres";
if (typeof createFeatureFlagRoutes !== "function" || typeof DrizzleFeatureFlagStore !== "function" || typeof installFeatureFlagSchemaV1 !== "function") throw new Error("Packed feature flag bindings did not load");
`,
    },
    {
      name: "generated-client",
      packages: ["@dads-framework/client-request-transport"],
      source: `import { defineGeneratedRoute, opaqueIdSchema } from "@dads-framework/contract";
import { getFromApi } from "@dads-framework/client-request-transport";
import { z } from "zod";
const documentId = opaqueIdSchema("DocumentId", "Document identifier.");
const getDocument = defineGeneratedRoute("GET", "/documents/:id", "getDocument", (id: z.output<typeof documentId>) => "/documents/" + encodeURIComponent(id));
const query = z.object({ page: z.coerce.number<string | number>().int().positive().default(1), status: z.enum(["open", "closed"]).optional() });
const data = z.object({ title: z.string() });
let requested = "";
globalThis.fetch = (url) => {
  requested = String(url);
  return Promise.resolve(new Response(JSON.stringify({ data: { title: "Hello" } }), { status: 200 }));
};
const route = getDocument.bind(documentId.parse("A B"));
const result = await getFromApi({ route, returns: data, query: { schema: query, value: { page: "2", status: "open" } } });
if (result.title !== "Hello" || !requested.includes("/documents/A%20B?page=2&status=open")) throw new Error("Generated transport lost request or response binding");
export function typeProof() {
  // @ts-expect-error Generated route requires its branded identity.
  getDocument.bind("unknown");
  // @ts-expect-error URL placeholder is required.
  getDocument.bind();
  // @ts-expect-error Query shape stays scalar.
  getFromApi({ route, returns: data, query: { schema: query, value: { page: { invalid: true } } } });
  // @ts-expect-error Query enum stays narrow.
  getFromApi({ route, returns: data, query: { schema: query, value: { status: "invalid" } } });
}
`,
    },
  ];
}
