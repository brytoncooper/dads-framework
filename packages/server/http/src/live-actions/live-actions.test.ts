import { describe, expect, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import { isDomainError } from "@dads-framework/core/errors";

import { executeLiveAction } from "./execute-live-action.js";
import { defineLiveAction } from "./live-action.js";
import { createLiveActionRegistry, LiveActionRegistry } from "./live-action-registry.js";
import { InMemoryLiveActionRunStore, type LiveActionRunRecord } from "./live-action-run-store.js";
import { redactActionInput } from "./redact-input.js";

const cacheClearAction = defineLiveAction({
  name: "cache.clear-prefix",
  description: "Clear cached entries matching a prefix",
  dangerLevel: "cautious",
  permission: permissionToken("ops/cache", "clear"),
  inputSchema: z.strictObject({
    prefix: z.string().min(1),
    apiKey: z.string().optional(),
  }),
  execute: ({ input }) =>
    Promise.resolve({
      summary: `Cleared prefix ${input.prefix}`,
      details: { prefix: input.prefix },
    }),
});

describe("defineLiveAction & LiveActionRegistry", () => {
  it("validates action names, descriptions, and permissions", () => {
    expect(cacheClearAction.name).toBe("cache.clear-prefix");
    expect(cacheClearAction.dangerLevel).toBe("cautious");

    const resourcePermAction = defineLiveAction({
      name: "billing.reconcile",
      description: "Reconcile pending workspace invoices",
      dangerLevel: "destructive",
      permission: { entity: "workspace", permission: "reconcile", resourceId: "global" },
      inputSchema: z.strictObject({ workspaceId: z.string() }),
      execute: () => Promise.resolve({ summary: "Reconciled" }),
    });
    expect(resourcePermAction.name).toBe("billing.reconcile");

    expect(() =>
      defineLiveAction({
        name: "Invalid_Name",
        description: "Valid description with plenty of detail",
        dangerLevel: "safe",
        permission: permissionToken("ops/cache", "clear"),
        inputSchema: z.strictObject({}),
        execute: () => Promise.resolve({ summary: "ok" }),
      }),
    ).toThrow(/Invalid live action name/);

    expect(() =>
      defineLiveAction({
        name: "cache.ping",
        description: "Too short",
        dangerLevel: "safe",
        permission: permissionToken("ops/cache", "clear"),
        inputSchema: z.strictObject({}),
        execute: () => Promise.resolve({ summary: "ok" }),
      }),
    ).toThrow(/at least 10 characters/);
  });

  it("registers, looks up, lists, and rejects duplicate names", () => {
    const registry = createLiveActionRegistry([cacheClearAction]);
    expect(registry.get("cache.clear-prefix")).toBe(cacheClearAction);
    expect(registry.get("missing.action")).toBeUndefined();
    expect(registry.list()).toEqual([cacheClearAction]);

    expect(() => registry.register(cacheClearAction)).toThrow(/already registered/);

    const empty = new LiveActionRegistry();
    expect(empty.list()).toEqual([]);
  });
});

describe("redactActionInput", () => {
  it("recursively redacts sensitive keys across nested structures and circular refs", () => {
    const shared = { id: "ws-1", label: "shared" };
    const cyclic: Record<string, unknown> = {
      workspaceId: "ws-1",
      password: "raw-password",
      nested: {
        clientSecret: "raw-secret",
        accessToken: "tok-123",
        apiKey: "key-1",
        api_key: "key-2",
        authorizationHeader: "Bearer xyz",
        sessionCookie: "sid=abc",
        privateKey: "pem-body",
        private_key: "pem-body-2",
        dbCredentials: { user: "root", pass: "123" },
        safeField: "visible",
      },
      items: [{ token: "hidden" }, shared, shared],
    };
    cyclic["self"] = cyclic;

    const redacted = redactActionInput(cyclic);
    expect(redacted).toEqual({
      workspaceId: "ws-1",
      password: "[REDACTED]",
      nested: {
        clientSecret: "[REDACTED]",
        accessToken: "[REDACTED]",
        apiKey: "[REDACTED]",
        api_key: "[REDACTED]",
        authorizationHeader: "[REDACTED]",
        sessionCookie: "[REDACTED]",
        privateKey: "[REDACTED]",
        private_key: "[REDACTED]",
        dbCredentials: "[REDACTED]",
        safeField: "visible",
      },
      items: [{ token: "[REDACTED]" }, { id: "ws-1", label: "shared" }, { id: "ws-1", label: "shared" }],
      self: "[CIRCULAR]",
    });
  });

  it("applies custom redactor and still enforces built-in sensitive key redaction", () => {
    const redacted = redactActionInput({ email: "ops@example.com", secret: "s3cr3t", note: "keep" }, (input) => ({
      ...input,
      email: "[EMAIL_REDACTED]",
    }));
    expect(redacted).toEqual({
      email: "[EMAIL_REDACTED]",
      secret: "[REDACTED]",
      note: "keep",
    });
  });
});

describe("executeLiveAction & InMemoryLiveActionRunStore", () => {
  it("records start with redacted input and finishes with succeeded outcome", async () => {
    const store = new InMemoryLiveActionRunStore();
    let seenRunning: LiveActionRunRecord | undefined;
    const timestamps = [new Date("2026-11-23T10:00:00.000Z"), new Date("2026-11-23T10:00:02.000Z")];
    let index = 0;

    const action = defineLiveAction({
      name: "workspace.reindex",
      description: "Rebuild search index for a workspace",
      dangerLevel: "safe",
      permission: permissionToken("workspaces/workspace", "reindex"),
      inputSchema: z.strictObject({
        workspaceId: z.string(),
        apiToken: z.string(),
      }),
      execute: async ({ input, runId }) => {
        seenRunning = await store.getById(runId);
        return { summary: `Reindexed ${input.workspaceId}` };
      },
    });

    const record = await executeLiveAction({
      action,
      caller: { type: "user", id: "operator-1" },
      reason: "Search index drifted after import",
      input: { workspaceId: "ws-9", apiToken: "secret-token-value" },
      store,
      canExecute: () => Promise.resolve(true),
      now: () => timestamps[index++] ?? new Date("2026-11-23T10:00:05.000Z"),
    });

    expect(seenRunning?.outcome).toBe("running");
    expect(seenRunning?.finishedAt).toBeNull();
    expect(seenRunning?.redactedInput).toEqual({ workspaceId: "ws-9", apiToken: "[REDACTED]" });

    expect(record.outcome).toBe("succeeded");
    expect(record.summary).toBe("Reindexed ws-9");
    expect(record.errorMessage).toBeNull();
    expect(record.startedAt).toEqual(new Date("2026-11-23T10:00:00.000Z"));
    expect(record.finishedAt).toEqual(new Date("2026-11-23T10:00:02.000Z"));
    expect(z.uuidv7().safeParse(record.id).success).toBe(true);

    const stored = await store.getById(record.id);
    expect(stored).toEqual(record);
  });

  it("records failed outcome when the action throws", async () => {
    const store = new InMemoryLiveActionRunStore();
    const failingAction = defineLiveAction({
      name: "jobs.replay",
      description: "Replay dead-lettered background jobs",
      dangerLevel: "cautious",
      permission: permissionToken("ops/jobs", "replay"),
      inputSchema: z.strictObject({ batchSize: z.number().int().positive() }),
      execute: () => Promise.reject(new Error("Queue backend timed out")),
    });

    const record = await executeLiveAction({
      action: failingAction,
      caller: { type: "user", id: "operator-1" },
      reason: "Recover stalled batch after outage",
      input: { batchSize: 10 },
      store,
      canExecute: () => Promise.resolve(true),
    });

    expect(record.outcome).toBe("failed");
    expect(record.summary).toBeNull();
    expect(record.errorMessage).toBe("Queue backend timed out");
    expect(record.finishedAt).toBeInstanceOf(Date);
    expect(await store.getById(record.id)).toEqual(record);
  });

  it("applies redactError from the action definition and execute options to sanitize stored error messages", async () => {
    const store = new InMemoryLiveActionRunStore();
    const sensitiveAction = defineLiveAction({
      name: "db.vacuum",
      description: "Run targeted vacuum against a database table",
      dangerLevel: "cautious",
      permission: permissionToken("ops/db", "vacuum"),
      inputSchema: z.strictObject({ table: z.string().min(1) }),
      redactError: (error) => (error instanceof Error ? "Database operation failed [REDACTED]" : "Unknown failure"),
      execute: () => Promise.reject(new Error("postgres://admin:super-secret@db.internal:5432/prod failed")),
    });

    const fromDefinition = await executeLiveAction({
      action: sensitiveAction,
      caller: { type: "user", id: "operator-1" },
      reason: "Reclaim dead tuples after migration",
      input: { table: "orders" },
      store,
      canExecute: () => Promise.resolve(true),
    });

    expect(fromDefinition.outcome).toBe("failed");
    expect(fromDefinition.errorMessage).toBe("Database operation failed [REDACTED]");
    expect(fromDefinition.errorMessage).not.toContain("super-secret");
    expect((await store.getById(fromDefinition.id))?.errorMessage).toBe("Database operation failed [REDACTED]");

    const fromOptions = await executeLiveAction({
      action: sensitiveAction,
      caller: { type: "user", id: "operator-1" },
      reason: "Retry vacuum with custom caller redactor",
      input: { table: "orders" },
      store,
      canExecute: () => Promise.resolve(true),
      redactError: () => "Sanitized by executeLiveAction caller",
    });

    expect(fromOptions.outcome).toBe("failed");
    expect(fromOptions.errorMessage).toBe("Sanitized by executeLiveAction caller");
    expect((await store.getById(fromOptions.id))?.errorMessage).toBe("Sanitized by executeLiveAction caller");
  });

  it("denies unauthorized callers before validating input or persisting runs", async () => {
    const store = new InMemoryLiveActionRunStore();
    let thrown: unknown;
    try {
      await executeLiveAction({
        action: cacheClearAction,
        caller: { type: "user", id: "viewer-1" },
        reason: "Attempting unauthorized execution",
        input: { invalidField: 123 },
        store,
        canExecute: () => Promise.resolve(false),
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isDomainError(thrown)).toBe(true);
    if (isDomainError(thrown)) {
      expect(thrown.kind).toBe("not-found");
    }
    expect(await store.listRecent()).toEqual([]);
  });

  it("rejects invalid action input with a validation error without persisting runs", async () => {
    const store = new InMemoryLiveActionRunStore();
    let thrown: unknown;
    try {
      await executeLiveAction({
        action: cacheClearAction,
        caller: { type: "user", id: "operator-1" },
        reason: "Testing schema validation",
        input: { prefix: "" },
        store,
        canExecute: () => Promise.resolve(true),
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isDomainError(thrown)).toBe(true);
    if (isDomainError(thrown)) {
      expect(thrown.kind).toBe("validation");
    }
    expect(await store.listRecent()).toEqual([]);
  });
});
