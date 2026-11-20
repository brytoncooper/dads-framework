# @dads-framework/health — process probes

Use `createHealthRoutes(checks)` to expose separate checks for processes and
traffic routers. `/health` confirms the process responds. `/ready` evaluates
the application's readiness probes. Register the routes during API composition
and supply probes for dependencies required to serve traffic.

## Try it

With the health routes registered under `/api`, run:

```sh
curl --fail http://localhost:3000/api/health
```

## What it refuses to do

Readiness is based on probes the application supplies. Health reporting cannot substitute for an application's tests.

See [the HTTP package](../http/README.md) for request IDs and logging.
