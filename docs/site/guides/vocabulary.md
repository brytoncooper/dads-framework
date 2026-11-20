# Dads vocabulary

When you change a feature, these names tell you who owns the behavior,
which app exposes it, and which test proves it. The examples follow
Notes in the starter.

## Dads, `dad`, starter, and Workbench

**Dads** is the framework and its packages. **`dad`** is the command-line
tool for working in a Dads project. The **starter** is the app you get
from `npm create dads`. Its source lives in the framework repository as
**Kit Workbench** (`apps/kit-workbench`). The repository also has a
reference task API called **Workbench** (`apps/workbench`).

For example, create the starter and save a note to see a complete feature
run locally. [Quickstart](./quickstart.md) ·
[Reference Workbench](../../../apps/workbench/README.md)

## Domain and API

A **domain** owns a feature's behavior and the rules around its data.
An **API** is a running surface that selects which operations to expose.

Notes owns the note routes. The customer API mounts them, and the staff
API exposes its own selection of operations. The app entry point is
where you look to find out which routes a caller can reach.
[Notes domain](../../../apps/kit-workbench/domains/notes/index.ts) ·
[Customer API](../../../apps/kit-workbench/apps/customer/app.ts) ·
[Staff API](../../../apps/kit-workbench/apps/staff/app.ts)

## Contract and schema

An HTTP **contract** describes an operation at the boundary, including
its method, path, and input and output shapes. A **schema** is a runtime
definition for parsing one of those shapes.

The create-note contract uses `noteInput` to parse the body. That schema
trims the text and checks its length. Look in the contract when changing
what callers send or receive.
[Notes route contract](../../../apps/kit-workbench/domains/notes/server/routes.ts) ·
[Notes schemas](../../../apps/kit-workbench/domains/notes/contract/wire.ts)

## Plugin and kit

A **plugin** declares what it contributes to a host and which services it
needs. A **kit** is a framework capability package, such as feature flags.

The Notes plugin asks for starter services and contributes routes and a
flag definition. The feature flags package supplies the capability the
app uses to evaluate that flag.
[Notes plugin](../../../apps/kit-workbench/domains/notes/server/plugin.ts) ·
[Feature flags](./flags.md)

## Library, port, and adapter

A **library** groups reusable code or declarations behind an entry point.
A **port** describes the operations a caller needs. An **adapter**
implements those operations for a particular technology.

The starter's app runtime library declares that its file service uses the
`ObjectStorage` port. The starter assembly picks the storage
implementation. This gives Notes a file service it can use without
choosing where attachments live.
[Runtime library](../../../apps/kit-workbench/libraries/app-runtime/index.ts) ·
[Local service assembly](../../../apps/kit-workbench/assembly/local-services.ts)

## Relation, permission, and scope

A **relation** records how a subject is connected to an object, such as an
account's membership in a tenant. A **permission** describes an action the
subject can take, based on rules that evaluate those relationships. A
**scope** is the boundary, such as a tenant, within which access applies.

The Notes route checks the tenant's `view` permission using the
`tenantId` from the URL. The integration test exercises an allowed
request and denial for a signed-in caller outside the tenant.
[Notes access rule](../../../apps/kit-workbench/domains/notes/access/index.ts) ·
[Starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts) ·
[Permissions guide](./permissions.md)

## Reader and writer

A **reader** looks up stored data. A **writer** changes it. Giving a
caller only a reader makes that part of the app easier to reason about.
You can test a business rule with a small in-memory implementation and
test the SQL separately.

The audit package uses a reader to look up request logs. Its retention
job gets a writer that deletes old rows and returns the number removed.
[Request log reader](../../../packages/server/audit/src/lib/database/readers/request-log-reader.interface.ts) ·
[Request log writer](../../../packages/server/audit/src/lib/database/writers/request-log-writer.interface.ts)
