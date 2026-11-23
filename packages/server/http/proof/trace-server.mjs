import assert from "node:assert/strict";
import process from "node:process";
import { URL } from "node:url";
import {
  createHttpApp,
  getRoute,
  registerRoutes,
  requireSession,
  routeGroup,
} from "../dist/index.js";
import pg from "pg";
import { z } from "zod";

export async function runRequest(telemetry) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    currentTraceId: telemetry.currentTraceId,
    requestTrace: telemetry.annotateRequest,
  });
  const route = getRoute({
    path: "/ready",
    summary: "Read service status",
    access: requireSession(),
    response: z.strictObject({ ok: z.boolean() }),
    handler: async () => {
      if (process.env.DADS_TEST_POSTGRES_URL !== undefined) {
        const pool = new pg.Pool({
          connectionString: process.env.DADS_TEST_POSTGRES_URL,
        });
        try {
          await pool.query("select $1::text", ["sensitive-query-value"]);
        } finally {
          await pool.end();
        }
      }
      return { ok: true };
    },
  });
  registerRoutes(app, {
    routes: routeGroup("Status", [route]),
    subjects: {
      resolve: () => Promise.resolve({ type: "user", id: "opaque-user-id" }),
    },
    authorization: { check: () => Promise.resolve(false) },
    auditActorForSubject: ({ subject, requestId }) => ({
      kind: subject === null ? "anonymous" : "user",
      id: subject?.id ?? "",
      requestId,
      reason: "sensitive-audit-reason",
    }),
  });

  const requestId =
    process.env.DADS_TELEMETRY_TEST_REQUEST_ID ?? "request-proof-1";
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await globalThis.fetch(
      new URL("/ready?hidden=sensitive-query-param", url),
      {
        headers: {
          authorization: "Bearer sensitive-token",
          cookie: "secret=sensitive-cookie",
          "x-request-id": requestId,
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.deepEqual(await response.json(), { data: { ok: true } });
  } finally {
    await app.close();
  }
}
