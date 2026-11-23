# Stale-save protection

A versioned update checks the revision the editor originally loaded. When
two drafts were based on the same revision, at most one can update the row.

## Contract and route

Expose `rowVersion: rowVersionSchema` in reads and successful updates. Spread
`expectedRowVersionFields` from `@dads-framework/core/contract` into the strict
update body. The client sends the version from the record it started editing.
The HTTP kit rejects missing or invalid versions with a validation response.

Declare the resource permission on the route. For Postgres-backed
authorization, recheck the permission inside the serializable transaction
that writes the row. Use the [protected transaction helper](../../packages/server/postgres-access/README.md#protected-writes)
to bind the decision and update to the same transaction. After authorization,
run `updateAtRowVersion` from `@dads-framework/postgres` on that transaction.
Supply a predicate for one row, including the tenant when the row is
tenant-owned. Pass only the editable fields in the changes object. The helper
matches the expected version and increments the stored version in one SQL
statement. PostgreSQL serializes competing updates to the same row.

```ts
const [saved] = await updateAtRowVersion(tx, notes, {
  where: and(eq(notes.id, id), eq(notes.tenantId, tenantId)),
  expectedRowVersion: input.expectedRowVersion,
  changes: { title: input.title },
});

if (saved === undefined) throw staleSave();
return { id, title: input.title, rowVersion: saved.rowVersion };
```

A zero-row result can also mean the authorized row disappeared. If the app
distinguishes deletion, resolve that outcome inside the authorized scope.
`staleSave()` from `@dads-framework/core/errors` produces the standard HTTP 409
error with code `ROW_VERSION_CONFLICT`. The refusal carries no current
record or revision. Clients read current state through the authorized read
route.

## Client recovery

Keep the original revision and draft together. Use `saveWithRefresh` from
`@dads-framework/client` to make one write attempt and read
the latest record after a stale refusal.

```ts
const result = await saveWithRefresh({
  save: () =>
    saveNote(id, { title: draft.title, expectedRowVersion: draft.rowVersion }),
  refresh: () => getNote(id),
});

if (result.kind === "stale") {
  showReview({ draft, latest: result.latest });
} else {
  showSaved(result.value);
}
```

A user can discard the draft or reapply selected edits after review. A
subsequent save sends the reviewed record's revision. Failed refreshes and
unrelated errors use the app's existing failure path.

## Resource generator

The resource generator wires the contract and conditional SQL described
above. Use the same steps for an existing editable Postgres resource.
[Generator guide](../generators.md)

1. Add a non-null integer `rowVersion` column with default `1`. Include it
   in mapped read and save responses.
2. Add the required field to the strict update contract and render an
   existing resource permission on the update route.
3. Generate the scoped conditional write in the caller's transaction and
   throw `staleSave()` after a version mismatch. Each other writer of the
   same editable fields must also advance the row's version.
4. Generate proof that an authorized stale draft cannot replace newer
   content and a caller without the relationship cannot learn the outcome.
