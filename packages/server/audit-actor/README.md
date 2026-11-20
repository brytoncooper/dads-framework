# `@dads-framework/audit-actor`

Carry the actor and request ID through asynchronous server work so an audited
Postgres write can identify the request, job, or script that caused it.

HTTP and job adapters establish this context at ingress. The attributed
Postgres pool reads it on each connection checkout, before any query runs.
For your own script or seed, enter a named system context around the work.

## What is here

| File                     | Holds                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `audit-actor.ts`         | The actor schema and the serialize/parse pair shared by the database setting and trigger.     |
| `audit-actor-context.ts` | The one `AsyncLocalStorage`, plus the system and anonymous actor helpers the three seams use. |

For HTTP subjects, use the subject mapping in [the audit package](../audit/README.md).

Applications can supply lowercase actor kind identifiers up to 64 characters,
using letters, digits, underscores, and hyphens. The first character is a
letter. The audit trigger requires an actor stamp on audited writes.

## Try it

```ts
import {
  currentAuditActor,
  withSystemActor,
} from "@dads-framework/audit-actor";

await withSystemActor("scheduled-cleanup", () => {
  console.log(currentAuditActor()?.id); // scheduled-cleanup
});
```

## What it refuses to do

The application supplies attributed identity. The actor package does not authorize or authenticate a request.
