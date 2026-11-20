# @dads-framework/audit-actor

> **TL;DR:** Who is acting, in one dependency-free place: the `AuditActor` vocabulary, the exact JSON the Postgres `dads.audit_actor` setting carries, and the `AsyncLocalStorage` context that carries it. It lives apart from `@dads-framework/audit` because the postgres kit (attributed pool), the http kit (request scope), and the job-queue kit (system actor per job) all need the actor and none of them may depend on the audit kit to get it. **Read the rest when:** establishing an actor context at a new seam, or asking how an actor reaches the database.

> **Status:** implemented — the attributed pool in `@dads-framework/postgres` reads this context on every connection checkout, and the HTTP, job, and SCIM seams enter it.

## What is here

| File                     | Holds                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `audit-actor.ts`         | The seven actor kinds, the Zod schema, and the serialize/parse pair the database setting and trigger agree on. |
| `audit-actor-context.ts` | The one `AsyncLocalStorage`, plus the system and anonymous actor helpers the three seams use.                  |

The mapping from an authorization `SubjectRef` to an `AuditActor` is NOT here:
it needs the authorization kit and the domain access barrels, so it lives in
`@dads-framework/audit` (`subject-to-audit-actor.ts`) and keeps this lib free of
those dependencies.

Applications can supply lowercase actor kind identifiers up to 64 characters,
using letters, digits, underscores, and hyphens. The first character is a
letter. The audit trigger requires an actor stamp on audited writes.

## Try it

```ts
import { systemActor } from "@dads-framework/audit-actor";

const actor = systemActor("scheduled-cleanup");
```

## What it refuses to do

The application supplies attributed identity. The actor package does not authorize or authenticate a request.
