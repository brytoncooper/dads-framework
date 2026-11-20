# Request work invariants

Rules about per-request work accounting: what may be charged to a request, and what a charge is never allowed to change.

- INV-REQUESTWORK-1: A counter called outside any request context changes nothing and throws nothing, so job, migration and request-log-sink work is never charged to a request — enforced by `src/lib/request-work-tally.ts#countDatabaseQuery`, `src/lib/request-work-tally.test.ts`, `src/lib/charge-request-work.test.ts`
- INV-REQUESTWORK-2: A charged call returns its value and rethrows its rejection unaltered, and a call that failed is charged exactly like one that succeeded — enforced by `src/lib/charge-request-work.ts`, `src/lib/charge-request-work.test.ts`
- INV-REQUESTWORK-3: A call is charged to the request whose async task issued it, never to whichever request checked the connection out — enforced by `src/lib/request-work-tally.ts#countDatabaseQuery`, `src/lib/request-work-tally.test.ts`
- INV-REQUESTWORK-4: A request's tally survives every nested actor or consistency context entered during that request — enforced by `src/lib/request-work-tally.ts`, `src/lib/request-work-tally.test.ts`
- INV-REQUESTWORK-5: A client is instrumented once however many times it is checked out, so one statement is counted once — enforced by `packages/server/postgres/src/lib/counting-client.ts#countStatementsOn`, `packages/server/postgres/src/lib/counting-client.test.ts`
