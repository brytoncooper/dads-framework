# `@dads-framework/audit-actor`

Carry the actor and request ID through asynchronous server work so an audited
Postgres write can identify the request, job, or script that caused it.

## Try it

In the generated starter, [`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts) passes
`currentAuditActor` to the Postgres pool so it can stamp each connection at
checkout. [`assembly/start-app.ts`](../../../apps/kit-workbench/assembly/start-app.ts) supplies an anonymous actor for
HTTP requests with no resolved subject.

Use Node.js 22 or later. The example reads async attribution directly and
needs no database.

```sh
npm install @dads-framework/audit-actor
npm install -D tsx
```

Save as `audit-context.mts` and run `npx tsx audit-context.mts`.

<!-- dads:check-example -->

```ts
import {
  currentAuditActor,
  parseAuditActor,
  serializeAuditActor,
  withReason,
  withSystemActor,
} from "@dads-framework/audit-actor";

await withSystemActor("scheduled-cleanup", async () => {
  await withReason("expired cache entry", async () => {
    await Promise.resolve();
    const actor = currentAuditActor();
    if (actor === undefined) throw new Error("Expected an audit actor.");

    const stamp = parseAuditActor(serializeAuditActor(actor));
    console.log(stamp?.id, stamp?.reason);
  });
  console.log(currentAuditActor()?.reason);
});
console.log(currentAuditActor());
```

It prints `scheduled-cleanup expired cache entry`, then `undefined` twice.
The reason ends with its inner scope and the actor ends with the outer scope.

## Use it

Pass `currentAuditActor` as the actor source when creating an attributed
connection with `@dads-framework/postgres`. The pool reads the source on every
checkout and stamps the connection for the database trigger. Set the context
before opening a database transaction. For HTTP subjects, use the subject
mapping in [the audit package](../audit/README.md).

## What it refuses to do

The application supplies attributed identity. The actor package does not authorize or authenticate a request.

## Contract

The built-in kinds are `user`, `system`, and `anonymous`. Applications may
supply lowercase identifiers up to 64 characters that start with a letter and
contain letters, digits, underscores, or hyphens. The kind `unattributed` is
reserved. A request ID is required, and a reason may have up to 512 characters.
`parseAuditActor` returns `null` for an empty, malformed, or invalid stamp.
The database trigger rejects writes without an actor on tables configured for audit.
