# Diagnostics invariants

Rules about capturing a server fault: what may be recorded, and what capturing
is never allowed to do.

- INV-DIAGNOSTICS-1: Capturing a fault never throws and never returns a promise a caller could await, so an error handler, a fatal signal handler, or a failed job cannot fail while handling a failure — enforced by `src/lib/diagnostics-reporter.ts`, `src/lib/log-diagnostics-reporter.ts`, `src/lib/log-diagnostics-reporter.test.ts`
- INV-DIAGNOSTICS-2: A fault's fingerprint never depends on its message, so rewording and interpolated values cannot fragment a group — enforced by `src/lib/logic/describe-exception.ts`, `src/lib/logic/describe-exception.test.ts`
- INV-DIAGNOSTICS-3: A fingerprint is built from application frames only — every frame except `node_modules` and `node:` internals — so a fault is identified by where the application went wrong rather than by the dependency frames beneath it, and the rule behaves identically in development and in the bundled image — enforced by `src/lib/logic/describe-exception.ts`, `src/lib/logic/describe-exception.test.ts`
- INV-DIAGNOSTICS-4: No stack and no exception message is ever written to a database column; both stay in the log line keyed by request id — enforced by `src/lib/log-diagnostics-reporter.ts`, `packages/server/http/src/lib/request-log/request-record.ts`
- INV-DIAGNOSTICS-5: A driver asked for without what it needs fails at boot rather than dropping every fault silently — enforced by `src/lib/create-diagnostics-reporter.ts`, `src/lib/create-diagnostics-reporter.test.ts`
