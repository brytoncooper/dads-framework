# @dads-framework/errors — typed failures

Give expected business failures stable codes that callers can handle without
matching human messages. Use `Result` when the caller needs to handle success
and failure explicitly. Construct a `DomainError` with `notFound`, `conflict`,
`validation`, or `forbidden` when the boundary owns failure handling. The
`@dads-framework/errors/map-error-to-http-response` export maps each error kind
to its HTTP status and envelope.

## Version conflicts

Use `staleSave()` after an authorized conditional update fails to match the expected revision. The standard error mapper sends HTTP 409 with `ROW_VERSION_CONFLICT`. See the [versioned update guide](../../../docs/architecture/stale-save.md).

## Try it

In a Node.js 22+ project, install the package.

```sh
npm install @dads-framework/errors
```

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { notFound } from "@dads-framework/errors";
import { mapErrorToHttpResponse } from "@dads-framework/errors/map-error-to-http-response";

const error = notFound("DOCUMENT_NOT_FOUND", "The document was not found.");
console.log(mapErrorToHttpResponse(error, "request-1").status); // 404
```

The script prints `404`. The HTTP mapper puts the stable
`DOCUMENT_NOT_FOUND` code in the response body.

## What it refuses to do

A domain result carries its declared value or failure. An HTTP or UI boundary chooses the representation for its caller.
