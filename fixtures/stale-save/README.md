# Stale-save fixture

An authorized, versioned HTTP update backed by a real PostgreSQL database.

## Try it

```sh
npm run build
npm run test:integration -w @dads-fixture/stale-save
```

With Docker running, the fixture verifies request validation, denial without
an edit relationship, and two drafts racing to save against the same revision.

## Use it

The fixture uses independently declared route, response, and database shapes.
Follow the [versioned update guide](../../docs/architecture/stale-save.md) to
wire those pieces into an app.

## What it refuses to do

An obsolete draft cannot overwrite the current row. A denied caller receives
the ordinary relationship denial.

## Contract

The update requires `expectedRowVersion`. Success returns the next
`rowVersion`. An authorized obsolete save receives HTTP 409
`ROW_VERSION_CONFLICT`.
