import { z } from "zod";

import { paginationQuerySchema } from "@dads-framework/core/contract";
import { notFound } from "@dads-framework/core/errors";

import { HttpWiringError } from "../lib/http-errors.js";
import { requireSession } from "../lib/route/access.js";
import { getRoute } from "../lib/route/get-route.js";
import { listRoute } from "../lib/route/list-route.js";
import { postRoute } from "../lib/route/post-route.js";
import { routeGroup, type HttpRoute } from "../lib/route/route-group.js";
import { executeLiveAction } from "./execute-live-action.js";
import type { LiveActionCaller, LiveActionDefinition } from "./live-action.js";
import type { LiveActionRegistry } from "./live-action-registry.js";
import type { LiveActionRunRecord, LiveActionRunStore } from "./live-action-run-store.js";

const DEFAULT_LIVE_ACTIONS_BASE_PATH = "/live-actions";
const MIN_REASON_LENGTH = 5;
const MAX_RUN_LIST_LIMIT = 100;

export const liveActionDangerLevelSchema = z.enum(["safe", "cautious", "destructive"]);

export const liveActionOutcomeSchema = z.enum(["running", "succeeded", "failed"]);

export const liveActionSummarySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  dangerLevel: liveActionDangerLevelSchema,
});

export type LiveActionSummary = z.infer<typeof liveActionSummarySchema>;

export const liveActionRunSchema = z.strictObject({
  id: z.string(),
  actionName: z.string(),
  dangerLevel: liveActionDangerLevelSchema,
  actorType: z.string(),
  actorId: z.string(),
  reason: z.string(),
  redactedInput: z.unknown(),
  outcome: liveActionOutcomeSchema,
  summary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export type LiveActionRunDto = z.infer<typeof liveActionRunSchema>;

const runLiveActionParamsSchema = z.strictObject({
  name: z.string().min(1),
});

const runLiveActionBodySchema = z.strictObject({
  reason: z.string().trim().min(MIN_REASON_LENGTH),
  input: z.unknown().optional(),
});

const listLiveActionRunsQuerySchema = paginationQuerySchema.extend({
  actionName: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RUN_LIST_LIMIT).optional(),
});

const getLiveActionRunParamsSchema = z.strictObject({
  runId: z.string().min(1),
});

export type LiveActionAuthorizeInput = {
  readonly subject: LiveActionCaller;
  readonly action: LiveActionDefinition;
};

export type LiveActionRoutesOptions = {
  readonly registry: LiveActionRegistry;
  readonly store: LiveActionRunStore;
  readonly authorize: (input: LiveActionAuthorizeInput) => Promise<boolean>;
  readonly basePath?: string;
  readonly now?: () => Date;
  /** Optional default sanitizer for error text persisted on failed runs when an action defines no `redactError`. */
  readonly redactError?: (error: unknown) => string;
};

function normalizeBasePath(basePath: string | undefined): string {
  const raw = basePath ?? DEFAULT_LIVE_ACTIONS_BASE_PATH;
  const trimmed = raw.endsWith("/") && raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed === "/") {
    throw new HttpWiringError(`Live actions basePath must be a non-root mount-relative path, received "${raw}"`);
  }
  return trimmed;
}

function serializeRun(run: LiveActionRunRecord): LiveActionRunDto {
  return {
    id: run.id,
    actionName: run.actionName,
    dangerLevel: run.dangerLevel,
    actorType: run.actorType,
    actorId: run.actorId,
    reason: run.reason,
    redactedInput: run.redactedInput,
    outcome: run.outcome,
    summary: run.summary,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
  };
}

async function listAuthorizedActions(
  registry: LiveActionRegistry,
  authorize: (input: LiveActionAuthorizeInput) => Promise<boolean>,
  subject: LiveActionCaller,
): Promise<readonly LiveActionDefinition[]> {
  const authorized: LiveActionDefinition[] = [];
  for (const action of registry.list()) {
    const allowed = await authorize({ subject, action });
    if (allowed) {
      authorized.push(action);
    }
  }
  return authorized;
}

function paginateItems<T>(items: readonly T[], page: number, perPage: number): readonly T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/**
 * Create the audited HTTP route group for listing, executing, and inspecting
 * live operational actions.
 *
 * Every route requires an authenticated session and enforces per-action
 * authorization. Unauthorized actions are omitted from lists and answered with
 * 404 on execution or run lookup so their existence is never revealed.
 */
export function createLiveActionRoutes(options: LiveActionRoutesOptions): HttpRoute[] {
  const basePath = normalizeBasePath(options.basePath);

  const listActionsRoute = listRoute({
    route: { method: "GET", template: basePath },
    summary: "List live operational actions authorized for the current caller",
    access: requireSession(),
    query: paginationQuerySchema,
    item: liveActionSummarySchema,
    handler: async ({ subject, query }) => {
      const actions = await listAuthorizedActions(options.registry, options.authorize, subject);
      const summaries = actions.map((action) => ({
        name: action.name,
        description: action.description,
        dangerLevel: action.dangerLevel,
      }));
      return {
        items: paginateItems(summaries, query.page, query.perPage),
        total: summaries.length,
      };
    },
  });

  const executeActionRoute = postRoute({
    route: { method: "POST", template: `${basePath}/:name/runs` },
    summary: "Execute a live operational action and persist its audit run record",
    access: requireSession(),
    params: runLiveActionParamsSchema,
    body: runLiveActionBodySchema,
    response: liveActionRunSchema,
    handler: async ({ subject, params, body }) => {
      const action = options.registry.get(params.name);
      if (action === undefined) {
        throw notFound("LIVE_ACTION_NOT_FOUND", "Live action not found");
      }
      const redactError = action.redactError ?? options.redactError;
      const run = await executeLiveAction({
        action,
        caller: subject,
        reason: body.reason,
        input: body.input,
        store: options.store,
        canExecute: ({ caller, action: target }) => options.authorize({ subject: caller, action: target }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(redactError === undefined ? {} : { redactError }),
      });
      return serializeRun(run);
    },
  });

  const listRunsRoute = listRoute({
    route: { method: "GET", template: `${basePath}/runs` },
    summary: "List recent live action runs for actions authorized to the caller",
    access: requireSession(),
    query: listLiveActionRunsQuerySchema,
    item: liveActionRunSchema,
    handler: async ({ subject, query }) => {
      const authorizedActions = await listAuthorizedActions(options.registry, options.authorize, subject);
      const authorizedNames = new Set(authorizedActions.map((action) => action.name));
      if (query.actionName !== undefined && !authorizedNames.has(query.actionName)) {
        return { items: [], total: 0 };
      }
      const runs = await options.store.listRecent(
        query.actionName === undefined ? undefined : { actionName: query.actionName },
      );
      const visibleRuns = runs.filter((run) => authorizedNames.has(run.actionName));
      const pageItems =
        query.limit === undefined
          ? paginateItems(visibleRuns, query.page, query.perPage)
          : visibleRuns.slice(0, query.limit);
      return {
        items: pageItems.map(serializeRun),
        total: visibleRuns.length,
      };
    },
  });

  const getRunRoute = getRoute({
    route: { method: "GET", template: `${basePath}/runs/:runId` },
    summary: "Read a single live action run if authorized for its action",
    access: requireSession(),
    params: getLiveActionRunParamsSchema,
    response: liveActionRunSchema,
    handler: async ({ subject, params }) => {
      const run = await options.store.getById(params.runId);
      if (run === undefined) {
        throw notFound("LIVE_ACTION_RUN_NOT_FOUND", "Live action run not found");
      }
      const action = options.registry.get(run.actionName);
      if (action === undefined) {
        throw notFound("LIVE_ACTION_RUN_NOT_FOUND", "Live action run not found");
      }
      const allowed = await options.authorize({ subject, action });
      if (!allowed) {
        throw notFound("LIVE_ACTION_RUN_NOT_FOUND", "Live action run not found");
      }
      return serializeRun(run);
    },
  });

  return routeGroup("Live Actions", [listActionsRoute, executeActionRoute, listRunsRoute, getRunRoute]);
}
