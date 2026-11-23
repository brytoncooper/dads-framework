import { describe, expect, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import { paginationMetaSchema } from "@dads-framework/core/contract";

import { buildTestApp, dataBodyOf, errorBodyOf, listBodyOf, TEST_SUBJECT_HEADER } from "../testing/index.js";
import { defineLiveAction } from "./live-action.js";
import { createLiveActionRegistry } from "./live-action-registry.js";
import { createLiveActionRoutes, liveActionRunSchema, liveActionSummarySchema } from "./live-action-routes.js";
import { InMemoryLiveActionRunStore } from "./live-action-run-store.js";

function createTestSuite(basePath?: string) {
  const safeAction = defineLiveAction({
    name: "cache.clear",
    description: "Clear cached entries for a namespace",
    dangerLevel: "safe",
    permission: permissionToken("ops/cache", "clear"),
    inputSchema: z.strictObject({
      namespace: z.string().min(1),
      apiKey: z.string().optional(),
    }),
    execute: ({ input }) =>
      Promise.resolve({
        summary: `Cleared namespace ${input.namespace}`,
      }),
  });

  const destructiveAction = defineLiveAction({
    name: "billing.void-batch",
    description: "Void pending invoices for an account",
    dangerLevel: "destructive",
    permission: permissionToken("billing/batch", "void"),
    inputSchema: z.strictObject({
      accountId: z.string().min(1),
      failNow: z.boolean().optional(),
    }),
    execute: ({ input }) => {
      if (input.failNow === true) {
        return Promise.reject(new Error("Ledger lock held"));
      }
      return Promise.resolve({ summary: `Voided batch for ${input.accountId}` });
    },
  });

  const registry = createLiveActionRegistry([safeAction, destructiveAction]);
  const store = new InMemoryLiveActionRunStore();
  const grants = new Map<string, ReadonlySet<string>>([
    ["operator", new Set(["cache.clear"])],
    ["admin", new Set(["cache.clear", "billing.void-batch"])],
  ]);

  const routes = createLiveActionRoutes({
    registry,
    store,
    authorize: ({ subject, action }) => Promise.resolve(grants.get(subject.id)?.has(action.name) ?? false),
    ...(basePath === undefined ? {} : { basePath }),
  });

  return { registry, store, routes };
}

describe("createLiveActionRoutes", () => {
  it("denies unauthenticated callers with 401 across every route", async () => {
    const { routes } = createTestSuite();
    const app = await buildTestApp({ routes });
    try {
      const listRes = await app.inject({ method: "GET", url: "/live-actions" });
      const execRes = await app.inject({
        method: "POST",
        url: "/live-actions/cache.clear/runs",
        payload: { reason: "Clear stale keys", input: { namespace: "docs" } },
      });
      const runsRes = await app.inject({ method: "GET", url: "/live-actions/runs" });
      const getRunRes = await app.inject({ method: "GET", url: "/live-actions/runs/run-1" });

      for (const response of [listRes, execRes, runsRes, getRunRes]) {
        expect(response.statusCode).toBe(401);
        expect(errorBodyOf(response).code).toBe("NOT_AUTHENTICATED");
      }
    } finally {
      await app.close();
    }
  });

  it("lists only authorized actions and returns an empty list for unauthorized callers", async () => {
    const { routes } = createTestSuite();
    const app = await buildTestApp({ routes });
    try {
      const outsiderRes = await app.inject({
        method: "GET",
        url: "/live-actions",
        headers: { [TEST_SUBJECT_HEADER]: "outsider" },
      });
      expect(outsiderRes.statusCode).toBe(200);
      expect(listBodyOf(outsiderRes, z.array(liveActionSummarySchema), paginationMetaSchema)).toEqual({
        data: [],
        meta: { total: 0, page: 1, perPage: 25 },
      });

      const operatorRes = await app.inject({
        method: "GET",
        url: "/live-actions",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(operatorRes.statusCode).toBe(200);
      const operatorList = listBodyOf(operatorRes, z.array(liveActionSummarySchema), paginationMetaSchema);
      expect(operatorList.data.map((item) => item.name)).toEqual(["cache.clear"]);
      expect(operatorList.meta.total).toBe(1);

      const adminRes = await app.inject({
        method: "GET",
        url: "/live-actions",
        headers: { [TEST_SUBJECT_HEADER]: "admin" },
      });
      expect(adminRes.statusCode).toBe(200);
      const adminList = listBodyOf(adminRes, z.array(liveActionSummarySchema), paginationMetaSchema);
      expect(adminList.data.map((item) => item.name)).toEqual(["cache.clear", "billing.void-batch"]);
    } finally {
      await app.close();
    }
  });

  it("executes authorized actions with input redaction and denies unauthorized or unknown actions with 404", async () => {
    const { routes, store } = createTestSuite();
    const app = await buildTestApp({ routes });
    try {
      const deniedExisting = await app.inject({
        method: "POST",
        url: "/live-actions/billing.void-batch/runs",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
        payload: { reason: "Trying forbidden action", input: { accountId: "acct-1" } },
      });
      const deniedUnknown = await app.inject({
        method: "POST",
        url: "/live-actions/does.not-exist/runs",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
        payload: { reason: "Trying missing action", input: {} },
      });

      expect(deniedExisting.statusCode).toBe(404);
      expect(deniedUnknown.statusCode).toBe(404);
      expect(errorBodyOf(deniedExisting)).toEqual(errorBodyOf(deniedUnknown));
      expect(await store.listRecent()).toEqual([]);

      const shortReason = await app.inject({
        method: "POST",
        url: "/live-actions/cache.clear/runs",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
        payload: { reason: "no", input: { namespace: "docs" } },
      });
      expect(shortReason.statusCode).toBe(400);

      const okRes = await app.inject({
        method: "POST",
        url: "/live-actions/cache.clear/runs",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
        payload: {
          reason: "Stale cache after deploy",
          input: { namespace: "docs", apiKey: "raw-api-key" },
        },
      });
      expect(okRes.statusCode).toBe(201);
      const run = dataBodyOf(okRes, liveActionRunSchema);
      expect(run.actionName).toBe("cache.clear");
      expect(run.outcome).toBe("succeeded");
      expect(run.summary).toBe("Cleared namespace docs");
      expect(run.redactedInput).toEqual({ namespace: "docs", apiKey: "[REDACTED]" });
      expect(run.actorId).toBe("operator");

      const failedRes = await app.inject({
        method: "POST",
        url: "/live-actions/billing.void-batch/runs",
        headers: { [TEST_SUBJECT_HEADER]: "admin" },
        payload: {
          reason: "Reconcile failed billing batch",
          input: { accountId: "acct-7", failNow: true },
        },
      });
      expect(failedRes.statusCode).toBe(201);
      const failedRun = dataBodyOf(failedRes, liveActionRunSchema);
      expect(failedRun.outcome).toBe("failed");
      expect(failedRun.errorMessage).toBe("Ledger lock held");
    } finally {
      await app.close();
    }
  });

  it("filters listed runs and denies unauthorized single-run reads with 404", async () => {
    const { routes } = createTestSuite();
    const app = await buildTestApp({ routes });
    try {
      const cacheRunRes = await app.inject({
        method: "POST",
        url: "/live-actions/cache.clear/runs",
        headers: { [TEST_SUBJECT_HEADER]: "admin" },
        payload: { reason: "Clear cache before run", input: { namespace: "notes" } },
      });
      const billingRunRes = await app.inject({
        method: "POST",
        url: "/live-actions/billing.void-batch/runs",
        headers: { [TEST_SUBJECT_HEADER]: "admin" },
        payload: { reason: "Void duplicate invoice batch", input: { accountId: "acct-9" } },
      });

      const cacheRun = dataBodyOf(cacheRunRes, liveActionRunSchema);
      const billingRun = dataBodyOf(billingRunRes, liveActionRunSchema);

      const operatorRunsRes = await app.inject({
        method: "GET",
        url: "/live-actions/runs",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(operatorRunsRes.statusCode).toBe(200);
      const operatorRuns = listBodyOf(operatorRunsRes, z.array(liveActionRunSchema), paginationMetaSchema);
      expect(operatorRuns.data.map((item) => item.id)).toEqual([cacheRun.id]);

      const unauthorizedFilterRes = await app.inject({
        method: "GET",
        url: "/live-actions/runs?actionName=billing.void-batch",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(unauthorizedFilterRes.statusCode).toBe(200);
      expect(listBodyOf(unauthorizedFilterRes, z.array(liveActionRunSchema), paginationMetaSchema).data).toEqual([]);

      const limitedAdminRes = await app.inject({
        method: "GET",
        url: "/live-actions/runs?limit=1",
        headers: { [TEST_SUBJECT_HEADER]: "admin" },
      });
      expect(limitedAdminRes.statusCode).toBe(200);
      const limitedAdmin = listBodyOf(limitedAdminRes, z.array(liveActionRunSchema), paginationMetaSchema);
      expect(limitedAdmin.data).toHaveLength(1);
      expect(limitedAdmin.meta.total).toBe(2);

      const allowedRunRead = await app.inject({
        method: "GET",
        url: `/live-actions/runs/${cacheRun.id}`,
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(allowedRunRead.statusCode).toBe(200);
      expect(dataBodyOf(allowedRunRead, liveActionRunSchema).id).toBe(cacheRun.id);

      const deniedRunRead = await app.inject({
        method: "GET",
        url: `/live-actions/runs/${billingRun.id}`,
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      const missingRunRead = await app.inject({
        method: "GET",
        url: "/live-actions/runs/nonexistent-run",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(deniedRunRead.statusCode).toBe(404);
      expect(missingRunRead.statusCode).toBe(404);
      expect(errorBodyOf(deniedRunRead)).toEqual(errorBodyOf(missingRunRead));
    } finally {
      await app.close();
    }
  });

  it("mounts under a custom basePath", async () => {
    const { routes } = createTestSuite("/ops/actions/");
    const app = await buildTestApp({ routes });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/ops/actions",
        headers: { [TEST_SUBJECT_HEADER]: "operator" },
      });
      expect(res.statusCode).toBe(200);
      const list = listBodyOf(res, z.array(liveActionSummarySchema), paginationMetaSchema);
      expect(list.data.map((item) => item.name)).toEqual(["cache.clear"]);
    } finally {
      await app.close();
    }
  });
});
