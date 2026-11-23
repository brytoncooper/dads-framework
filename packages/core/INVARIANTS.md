# Runtime invariants

## Request work

Rules about per-request work accounting: what may be charged to a request, and what a charge is never allowed to change.

- INV-REQUESTWORK-1: A counter called outside any request context changes nothing and throws nothing, so job, migration and request-log-sink work is never charged to a request — enforced by `src/request-work/lib/request-work-tally.ts#countDatabaseQuery`, `src/request-work/lib/request-work-tally.test.ts`, `src/request-work/lib/charge-request-work.test.ts`
- INV-REQUESTWORK-2: A charged call returns its value and rethrows its rejection unaltered, and a call that failed is charged exactly like one that succeeded — enforced by `src/request-work/lib/charge-request-work.ts`, `src/request-work/lib/charge-request-work.test.ts`
- INV-REQUESTWORK-3: A call is charged to the request whose async task issued it, never to whichever request checked the connection out — enforced by `src/request-work/lib/request-work-tally.ts#countDatabaseQuery`, `src/request-work/lib/request-work-tally.test.ts`
- INV-REQUESTWORK-4: A request's tally survives every nested actor or consistency context entered during that request — enforced by `src/request-work/lib/request-work-tally.ts`, `src/request-work/lib/request-work-tally.test.ts`
- INV-REQUESTWORK-5: A client is instrumented once however many times it is checked out, so one statement is counted once — enforced by `packages/server/postgres/src/lib/counting-client.ts#countStatementsOn`, `packages/server/postgres/src/lib/counting-client.test.ts`

## Diagnostics

Rules about capturing a server fault: what may be recorded, and what capturing
is never allowed to do.

- INV-DIAGNOSTICS-1: Capturing a fault never throws and never returns a promise a caller could await, so an error handler, a fatal signal handler, or a failed job cannot fail while handling a failure — enforced by `src/diagnostics/lib/diagnostics-reporter.ts`, `src/diagnostics/lib/log-diagnostics-reporter.ts`, `src/diagnostics/lib/log-diagnostics-reporter.test.ts`
- INV-DIAGNOSTICS-2: A fault's fingerprint never depends on its message, so rewording and interpolated values cannot fragment a group — enforced by `src/diagnostics/lib/logic/describe-exception.ts`, `src/diagnostics/lib/logic/describe-exception.test.ts`
- INV-DIAGNOSTICS-3: A fingerprint is built from application frames only — every frame except `node_modules` and `node:` internals — so a fault is identified by where the application went wrong rather than by the dependency frames beneath it, and the rule behaves identically in development and in the bundled image — enforced by `src/diagnostics/lib/logic/describe-exception.ts`, `src/diagnostics/lib/logic/describe-exception.test.ts`
- INV-DIAGNOSTICS-4: No stack and no exception message is ever written to a database column; both stay in the log line keyed by request id — enforced by `src/diagnostics/lib/log-diagnostics-reporter.ts`, `packages/server/http/src/lib/request-log/request-record.ts`
- INV-DIAGNOSTICS-5: A driver asked for without what it needs fails at boot rather than dropping every fault silently — enforced by `src/diagnostics/lib/create-diagnostics-reporter.ts`, `src/diagnostics/lib/create-diagnostics-reporter.test.ts`
