# HTTP and contracts

[`domains/notes/server/routes.ts`](../../../apps/kit-workbench/domains/notes/server/routes.ts)
defines **Create note** in the generated app. The route declares the URL
parameters, request body, response, and tenant access rule alongside the write.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/server/routes.ts", "language": "ts", "from": "    postRoute({", "through": "        );\n      },\n    }),"} -->

The HTTP kit parses the tenant ID and request body before calling the handler.
The handler rechecks the permission for that tenant in the transaction that
inserts the note. A successful response is HTTP **201** with a note under
`data`. The route's schemas also supply the OpenAPI contract.

## Define the wire shape

[`domains/notes/contract/wire.ts`](../../../apps/kit-workbench/domains/notes/contract/wire.ts)
defines the schemas shared by the route and client. Text is trimmed and must
contain 1–2,000 characters after trimming.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/contract/wire.ts", "language": "ts", "from": "export const noteInput = z.object({ text: z.string().trim().min(1).max(2000) });", "through": "  tenantId: z.uuid(),\n});"} -->

The server imports those schemas through
[`domains/notes/contract/index.ts`](../../../apps/kit-workbench/domains/notes/contract/index.ts),
which also defines `inTenant` to parse the URL's `tenantId`.

## Call it from the browser

[`domains/notes/web-client/index.ts`](../../../apps/kit-workbench/domains/notes/web-client/index.ts)
binds the tenant ID to the POST route, validates the request body, and parses
the response with the shared note schema.

<!-- dads:excerpt {"path": "apps/kit-workbench/domains/notes/web-client/index.ts", "language": "ts", "from": "export function createNote(tenantId: string, text: string) {", "through": "    returns: note,\n  });\n}"} -->

The [`apps/web/note-forms.tsx` form](../../../apps/kit-workbench/apps/web/note-forms.tsx)
calls `createNote` when you select **Add note**. The
[`tests/starter.integration.test.ts` integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
sends a POST as a workspace member and checks for 201, then reads the saved
note back.

<!-- dads:excerpt {"path": "apps/kit-workbench/tests/starter.integration.test.ts", "language": "ts", "from": "        const created = await customer.inject({", "through": "        expect(created.statusCode).toBe(201);"} -->

[See which API mounts the route](./composition.md) ·
[Follow the access check and its denial test](./guarded-resource.md)
