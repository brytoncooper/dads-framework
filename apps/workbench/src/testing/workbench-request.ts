import { createHttpApp, registerRoutes, type HttpRoute } from "@dads-framework/http";
import { z } from "zod";

import { workbenchAccessModel, type WorkbenchRequestSubject } from "../access.js";
import type { createWorkbench } from "../create-workbench.js";
import { checkWorkbenchPermission, workbenchAuthorizationReadError } from "../operations/workbench-authorization.js";
import { routeOutcome } from "../route-outcome.js";

const operations = {
  listWorkspaces: ["GET", "/api/workspaces"],
  createWorkspace: ["POST", "/api/workspaces"],
  getWorkspace: ["GET", "/api/workspaces/:workspaceId"],
  updateWorkspace: ["PATCH", "/api/workspaces/:workspaceId"],
  deleteWorkspace: ["DELETE", "/api/workspaces/:workspaceId"],
  listTasks: ["GET", "/api/workspaces/:workspaceId/tasks"],
  createTask: ["POST", "/api/workspaces/:workspaceId/tasks"],
  getTask: ["GET", "/api/tasks/:taskId"],
  updateTask: ["PATCH", "/api/tasks/:taskId"],
  deleteTask: ["DELETE", "/api/tasks/:taskId"],
  claimTask: ["POST", "/api/tasks/:taskId/claim"],
  listMembers: ["GET", "/api/workspaces/:workspaceId/members"],
  grantMember: ["POST", "/api/workspaces/:workspaceId/members"],
  revokeMember: ["DELETE", "/api/workspaces/:workspaceId/members/:userId"],
  listArtifacts: ["GET", "/api/tasks/:taskId/artifacts"],
  createArtifact: ["POST", "/api/tasks/:taskId/artifacts"],
  listActivity: ["GET", "/api/workspaces/:workspaceId/activity"],
  streamActivity: ["GET", "/api/workspaces/:workspaceId/activity/stream"],
} as const;

export type Operation = keyof typeof operations;

const operationNames: readonly Operation[] = [
  "listWorkspaces",
  "createWorkspace",
  "getWorkspace",
  "updateWorkspace",
  "deleteWorkspace",
  "listTasks",
  "createTask",
  "getTask",
  "updateTask",
  "deleteTask",
  "claimTask",
  "listMembers",
  "grantMember",
  "revokeMember",
  "listArtifacts",
  "createArtifact",
  "listActivity",
  "streamActivity",
];

type WorkbenchApp = ReturnType<typeof createWorkbench>;
type WorkbenchInput = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly subject?: WorkbenchRequestSubject | null;
  readonly requestId?: string;
};

const envelope = z.looseObject({
  data: z.unknown().optional(),
  meta: z.unknown().optional(),
  error: z.looseObject({ code: z.string() }).optional(),
});

export function operationOf(route: HttpRoute): Operation | undefined {
  return operationNames.find((name) => {
    const [method, path] = operations[name];
    return route.method === method && route.path === path;
  });
}

export async function executeWorkbenchRoute(route: HttpRoute | undefined, input: WorkbenchInput, app: WorkbenchApp) {
  if (route === undefined) throw new Error("Workbench route is unavailable");
  const http = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  try {
    registerRoutes(http, {
      routes: [route],
      accessModel: workbenchAccessModel,
      subjects: { resolve: () => Promise.resolve(input.subject ?? null) },
      authorization: {
        check: (query) =>
          routeOutcome(async () => {
            await app.operations.synchronize();
            return checkWorkbenchPermission(app.authorization, query);
          }),
      },
      lookups: {
        lookupResources: (query) =>
          routeOutcome(async () => {
            await app.operations.synchronize();
            return app.authorization.lookupResources(query).catch((cause: unknown) => {
              throw workbenchAuthorizationReadError(cause);
            });
          }),
      },
    });
    const url = routeUrl(route.path, input.params, input.query);
    const response = await http.inject({
      method: route.method,
      url,
      ...(input.body === undefined
        ? {}
        : {
            payload: JSON.stringify(input.body),
            headers: { "content-type": "application/json" },
          }),
    });
    const status = response.statusCode;
    const body = status === 204 ? envelope.parse({}) : envelope.parse(response.json<unknown>());
    return status < 400
      ? { kind: "success" as const, status, data: body.data, meta: body.meta }
      : {
          kind: "failure" as const,
          status,
          code: body.error?.code,
          error: body.error,
          data: body,
        };
  } finally {
    await http.close();
  }
}

function routeUrl(path: string, params: unknown, query: unknown): string {
  const values = z.record(z.string(), z.unknown()).catch({}).parse(params);
  const queryValues = z
    .record(z.string(), z.union([z.string(), z.number()]))
    .catch({})
    .parse(query);
  const filled = path.replace(/:(\w+)/g, (_, key: string) => {
    const value = values[key];
    return typeof value === "string" ? encodeURIComponent(value) : "";
  });
  const search = new URLSearchParams(Object.entries(queryValues).map(([key, value]) => [key, String(value)]));
  return search.size === 0 ? filled : `${filled}?${search}`;
}
