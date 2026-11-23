# Validation at the contract boundary

The [contract kit](../packages/core/README.md) exports shared Zod schemas
for IDs, request metadata, and response envelopes. Application domains own
their business request and response schemas. A route card uses those schemas
to parse incoming data, check outgoing data, and describe the operation in
OpenAPI.

## Reuse the same contract

```ts
import { entityIdSchema } from "@dads-framework/core/contract";
import { z } from "zod";

const documentId = entityIdSchema("DocumentId", "Document identifier.");
export const readDocumentParams = z.strictObject({ id: documentId });
export const documentResponse = z.object({ id: documentId, title: z.string() });
```

Use the parameter schema on the HTTP route and the response schema on both
the route and the [request transport](../packages/client/README.md).
The transport validates its response before handing data to application code.
Use `z.input` for data before parsing and `z.output` for data after parsing,
including defaults and transformations.

Keep schema coercion explicit where parameters and query values arrive as
text. A route card should describe what callers send and what handlers return.
The [HTTP kit](../packages/server/http/README.md) builds OpenAPI from the card's
request and response schemas.

For an input change, test a valid payload, a missing required field, and a
payload with an unfamiliar property when the schema is strict. For an output
change, exercise the request transport against the new response. Treat the
HTTP envelope and the application payload as separate contracts. The
[routes and contracts guide](./site/guides/routes-and-contracts.md) traces both through a
working route.
