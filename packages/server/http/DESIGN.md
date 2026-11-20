# HTTP — design

Rules this lib keeps that its README and `INVARIANTS.md` do not state. Each cites the test that proves it.

## Rules

- **byte-bodies-only-when-named**: An app hands a request body to its routes as raw bytes only for the content types it names. An app that names none answers 415 for those types before any handler runs, exactly as before the option existed. — proven by: raw-route-byte-body.test.ts::answers 415 for octet-stream when the app names no byte body type, as the cloud app does; raw-route-byte-body.test.ts::hands an opted-in body to the route as the exact bytes, under the route's own limit
- **raw-route-body-limit**: A raw route may declare its own bounded request body allowance, as a verb route may (INV-HTTP-7), without changing the application default for other routes. — proven by: raw-route-byte-body.test.ts::keeps the app's 1 MiB default limit for a raw route that declares none; raw-route-byte-body.test.ts::hands an opted-in body to the route as the exact bytes, under the route's own limit
