# @dads-framework/health — process probes

Use `createHealthRoutes(checks)` to expose separate checks for processes and
traffic routers. `/health` confirms the process responds. `/ready` evaluates
the application's readiness probes. Register the routes during API composition
and supply probes for dependencies required to serve traffic.

## Try it

In a Node.js 22+ project, install the packages.

```sh
npm install @dads-framework/health @dads-framework/http
```

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { createHealthRoutes } from "@dads-framework/health";
import { buildTestApp } from "@dads-framework/http/testing";

const app = await buildTestApp({
  routes: createHealthRoutes({
    pingDatabase: () => Promise.reject(new Error("Database unavailable")),
    pingCriticalServices: () => Promise.resolve(),
  }),
});
try {
  const live = await app.inject({ method: "GET", url: "/health" });
  const ready = await app.inject({ method: "GET", url: "/ready" });
  console.log(live.statusCode, ready.statusCode);
} finally {
  await app.close();
}
```

The simulated outage prints `200 503`. Liveness still succeeds. Replace
the example probes with your application’s dependency checks when
registering the routes in your HTTP app.

## What it refuses to do

Readiness is based on probes the application supplies. Health reporting cannot substitute for an application's tests.

See [the HTTP package](../http/README.md) for request IDs and logging.
