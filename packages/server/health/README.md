# @dads-framework/health — process probes

`createHealthRoutes()` is `/api/health` and `/api/ready`. Logging and
request-id live in `@dads-framework/http`
(`docs/architecture/observability.md`). The HTML origin page belongs to the
application's API composition root.

## Try it

```sh
curl --fail http://localhost:3000/api/health
```

## What it refuses to do

Readiness is based on probes the application supplies. Health reporting cannot substitute for an application's tests.
