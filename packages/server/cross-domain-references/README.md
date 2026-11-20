# cross-domain-references

Find dangling IDs after domains choose independent database schemas. Declare
each cross-domain reference and run a read-only check against Postgres. The
check reports stored IDs that have no target row, so you can clean up data
before adding a foreign key or moving records.

## Try it

In a Node.js 22+ project, install the packages.

```sh
npm install @dads-framework/cross-domain-references @dads-framework/postgres
```

Set `DATABASE_URL` to the connection string for a running PostgreSQL database. The
database role needs permission to create temporary tables.

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import {
  checkCrossDomainReferences,
  declareCrossDomainReferences,
} from "@dads-framework/cross-domain-references";
import { connectPostgresClient } from "@dads-framework/postgres";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("Set DATABASE_URL");

const references = declareCrossDomainReferences([
  {
    id: "orders.managing_organization_id",
    consumerDomain: "orders",
    consumerTable: "orders",
    consumerColumn: "managing_organization_id",
    providerDomain: "organizations",
    providerTable: "organizations",
    providerColumn: "id",
    classification: "live-association",
  },
]);

const client = await connectPostgresClient(databaseUrl);
try {
  await client.query("CREATE TEMP TABLE organizations (id text PRIMARY KEY)");
  await client.query(
    "CREATE TEMP TABLE orders (managing_organization_id text)",
  );
  await client.query("INSERT INTO orders VALUES ($1)", ["missing-org"]);
  const findings = await checkCrossDomainReferences(client, references);
  console.log(findings.flatMap((finding) => finding.sampleIds).join(", "));
} finally {
  await client.end();
}
```

The script prints `missing-org`. The temporary tables disappear when the
connection closes.

Declare references beside the consuming domain and call the check from an
operator command or CI job. The PostgreSQL integration test seeds a document
with a missing owner and verifies that the report identifies it.
[PostgreSQL integration test](./src/lib/database/check-cross-domain-references.integration.test.ts)

## A declaration

A reference belongs to the domain whose table carries the id, so the
declaration lives in that domain, never in a central file:

```ts
import { declareCrossDomainReferences } from "@dads-framework/cross-domain-references";
export const ordersCrossDomainReferences = declareCrossDomainReferences([
  {
    id: "orders.managing_organization_id",
    consumerDomain: "orders",
    consumerTable: "orders",
    consumerColumn: "managing_organization_id",
    providerDomain: "organizations",
    providerTable: "organizations",
    providerColumn: "id",
    classification: "live-association",
  },
]);
```

Each finding carries the reference's `classification` so an operator can
apply the application's repair policy. A polymorphic column — one whose
target table is chosen by a `*_kind` / `*_type` discriminator — is one
declaration per arm, each narrowed by `filters`, or by `discriminatedByParent`
when the discriminator sits on a parent row. `declareCrossDomainReferences`
refuses an unnarrowed arm at import: without the discriminator the check
reports every other arm's rows as dangling and proves none of its own.

A domain file lives at `src/lib/public-api/cross-domain-references.ts` — the
product's composition root reads it, so it is a cross-boundary promise and the
barrel may only export one from there. A kit declaring references for its own
tables keeps the file beside them, in `src/lib/database/`.

## Wiring the check

Pass the assembled declarations and an application-owned SQL client to the
check. A PostgreSQL pool satisfies the `CrossDomainReferenceQueryClient`
contract. The checker validates the rows returned by that client.

The product's composition root assembles one list:

```ts
export const applicationCrossDomainReferences = assembleCrossDomainReferences([
  ordersCrossDomainReferences,
  facilitiesCrossDomainReferences,
  // …one entry per domain that declares any
]);
```

An empty list is valid and means what it says — this product declares no
cross-domain reference yet. It is not silence: the check still runs and reports
that it checked nothing.

Pass the list to `checkCrossDomainReferences(client, references)` from a CI
job or an operator command. Use `CheckCrossDomainReferences` when wiring a
read-only diagnostic action in the application. The package provides report
formatters for clean results and dangling references.

## What counts as dangling

Existence, and only existence. A row naming a soft-deleted organization or
facility still points to an existing row. The accepting mutation owns
status and scope validation.

## What is deliberately not declared

Declare references whose target existence this query can check. These cases belong elsewhere.

- **SpiceDB object references** over an open string vocabulary — they are not
  rows in this database.
- **Frozen audit ids** a table states must never be resolved back to a live
  record.
- **Name-keyed references** (a `tag_name` scoped by organization), which need a
  composite check rather than this id-to-key shape.
- **Intra-domain columns with a real foreign key** — the database already
  refuses the orphan, so an anti-join could only return zero rows and would
  read as coverage it is not providing.

A domain's own file records the ones particular to it, beside the ones it does
declare.

## Brand owners

The reference check derives brand ownership from the
schema: the domain whose table declares `id: ….primaryKey()….$type<XId>()`
owns `XId`. A vendored table breaks that — Better Auth's `user.id` is a plain
text column — so the domain that holds it declares the brand it mints with
`declareCrossDomainBrandOwners`, in the same file as its references. That is
what lets the rule see a `UserId` column in another domain as the cross-domain
reference it is.
