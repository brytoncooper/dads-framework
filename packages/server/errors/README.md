# @dads-framework/errors — typed failures

`DomainError` (discriminated `kind` + stable SCREAMING_SNAKE `code`) with
its shorthand constructors (`notFound`, `conflict`, `validation`, `forbidden`),
the `Result` type for expected failures, and — under
`@dads-framework/errors/map-error-to-http-response` — the pure
`mapErrorToHttpResponse` table that turns errors into the HTTP error envelope
in exactly one place (docs/architecture/type-safety.md).

## Version conflicts

Use `staleSave()` after an authorized conditional update fails to match the expected revision. The standard error mapper sends HTTP 409 with `ROW_VERSION_CONFLICT`. See the [versioned update guide](../../../docs/architecture/stale-save.md).

## Try it

```ts
import { ok } from "@dads-framework/errors";

const result = ok({ id: "document-1" });
```

## What it refuses to do

A domain result carries its declared value or failure. An HTTP or UI boundary chooses the representation for its caller.
