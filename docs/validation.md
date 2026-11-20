# Validation at the contract boundary

The [contract kit](../packages/contract/README.md) exports shared Zod schemas
for IDs, request metadata, and response envelopes. Application domains own
their business request and response schemas. A route card uses those schemas
to parse incoming data, check outgoing data, and describe the operation in
OpenAPI.

## Reuse the same contract

```ts
import { entityIdSchema } from "@dads-framework/contract";
import { z } from "zod";

const documentId = entityIdSchema("DocumentId", "Document identifier.");
export const readDocumentParams = z.strictObject({ id: documentId });
export const documentResponse = z.object({ id: documentId, title: z.string() });
```

Use the parameter schema on the HTTP route and the response schema on both
the route and the [request transport](../packages/client/request-transport/README.md).
The transport validates its response before handing data to application code.
Use `z.input` for data before parsing and `z.output` for data after parsing,
including defaults and transformations.

Keep schema coercion explicit where parameters and query values arrive as
text. A route card should describe what callers send and what handlers return.
The [HTTP kit](../packages/server/http/README.md) builds OpenAPI from the card's
request and response schemas.
