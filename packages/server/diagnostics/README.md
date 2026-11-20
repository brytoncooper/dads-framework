# `@dads-framework/diagnostics`

Where a server fault goes.

Today a 500 produces exactly one thing: a pino line at the HTTP error handler
carrying the stack. Nothing groups it, nothing counts it, nothing notices when
a new one starts, and it survives only as long as log retention.
`request_log.error_code` says a request failed; it cannot say _what_ failed, or
whether it is the same thing that failed yesterday.

## The seam

`DiagnosticsReporter` names three things and no vendor: `captureException`,
`flush`, `close`. Capturing returns `void` and never throws — every caller is
already handling a failure and none of them can afford a second one.

## Drivers

| Driver   | Writes to                                   | For                                  |
| -------- | ------------------------------------------- | ------------------------------------ |
| `none`   | nowhere                                     | tests, and anything with no operator |
| `log`    | one structured line carrying a fingerprint  | the default, everywhere              |
| `sentry` | the `log` line, plus one envelope to Sentry | production                           |

`log` is more than a fallback. The line carries the same fingerprint an
aggregator would group by, so a plant-local operator at 2am gets the same
answer as someone with a dashboard — just with fewer clicks available.

`sentry` never replaces the line, and it needs no SDK: `sentry-envelope.ts`
builds the event — type, message with emails replaced, frames, level, our
fingerprint, route pattern, request id, job name, user id — and nothing else
leaves. No body, header, cookie, query string or email is ever sent.

OpenTelemetry is **not** a driver here. It attaches at the process level
through its own standard environment variables, so putting it in this union
would invent a second way to configure one thing.

## What never reaches a column

A stack and a message stay in the log line, keyed by request id.
`request_log` gets the exception's TYPE and its FINGERPRINT, because a message
can quote whatever a user typed and that table is bounded only by retention.

## Grouping

`describeException` is the only place on the server that reads a stack. The
fingerprint is the exception type plus its top **in-repo** frames, minus column
numbers — so it survives rewording, survives a reformat, and is not diluted by
the `node_modules` frames that look identical across a hundred different
faults. "Application" means every frame except `node_modules` and `node:`
internals — defined by exclusion because the production bundle is one file and
offers no repository root to test against.

See ADR-0117 and observability.
