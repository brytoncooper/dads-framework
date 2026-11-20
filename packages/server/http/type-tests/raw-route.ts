import { defineRawRoute } from "../src/lib/route/define-raw-route.js";

// @ts-expect-error Raw routes must declare access before registration.
defineRawRoute({
  method: "GET",
  path: "/nope",
  summary: "Raw route without access",
  openapi: {},
  handler: () => Promise.resolve(),
});
