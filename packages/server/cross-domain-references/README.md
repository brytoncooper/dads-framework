# cross-domain-references

The reconciliation half of ADR-0023,
as a kit every product runs.

Domains can replace cross-domain foreign keys with explicit references. That trade keeps
domain schemas on independent lifecycles, and the escape hatch it banks on is
that an FK can always be added later — which is true only while the data is
clean, because `ALTER TABLE … ADD FOREIGN KEY` fails on the first dangling row.
So every product LEFT JOINs every reference it declares to the key that
reference claims to point at, and reports the values that match nothing.

## A declaration

A reference belongs to the domain whose table carries the id, so the
declaration lives in that domain, never in a central file:

```ts
// libs/<product>/domains/orders/server/src/lib/public-api/cross-domain-references.ts
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

`classification` is ADR-0023's, and it travels with the finding so a report
reads with the policy that governs its repair. A polymorphic column — one whose
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
export const commandCrossDomainReferences = assembleCrossDomainReferences([
  ordersCrossDomainReferences,
  facilitiesCrossDomainReferences,
  // …one entry per domain that declares any
]);
```

An empty list is valid and means what it says — this product declares no
cross-domain reference yet. It is not silence: the check still runs and reports
that it checked nothing.

That list reaches two places:

- **`npm run db:check-references -- --product <name>`** — `tools/check-cross-domain-references`,
  for a database someone can already reach (local, CI, the nightly job). Exit
  codes: `0` clean, `1` dangling references found, `2` the check could not run.
- **The live-environment action `cross-domain-references.check`** — for the
  environments nobody should have to shell into. Routine tier, read-only, its
  handler delegating to this kit's `CheckCrossDomainReferences` query. The
  product declares it, not this kit: the live-environment-actions kit declares
  a loose reference of its own and therefore imports this one, so an action
  defined here would close a cycle. The application declares its own beside
  its API composition root.

## What counts as dangling

Existence, and only existence. A row naming a soft-deleted organization or
facility is fine: ADR-0023 archives referenced registry rows rather than
removing them, and status/scope validation belongs to the accepting mutation,
not to reconciliation.

## What is deliberately not declared

Registration is the only outcome for a loose cross-domain id column
withdrew the exception hatch, which had been an empty array for its whole life.
These are the cases the rule never sees at all, kept here so they are not
rediscovered as false positives:

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
