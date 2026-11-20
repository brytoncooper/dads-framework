import { workbenchActivityStream } from "./activity-stream.js";
import type { PermissionToken } from "@dads-framework/access";
import * as dad from "@dads-framework/http";
import { workbenchTask, workbenchWorkspace } from "./access.js";
import {
  activityResponse,
  artifactResponse,
  claimTaskBody,
  createArtifactBody,
  createTaskBody,
  createWorkspaceBody,
  grantMemberBody,
  listMeta,
  listQuery,
  memberParams,
  memberResponse,
  taskParams,
  taskResponse,
  updateTaskBody,
  updateWorkspaceBody,
  workspaceParams,
  workspaceResponse,
} from "./contracts.js";
import type { WorkbenchOperations } from "./operations/workbench-operations.js";
import { listOutcome, routeOutcome } from "./route-outcome.js";

function requirePermission(
  token: PermissionToken,
  parameter: string,
): dad.PermissionAccess {
  return {
    kind: "permission",
    resourceType: token.entityWireName,
    permission: token.permissionName,
    resourceId: dad.fromParam(parameter),
  };
}

function visible(token: PermissionToken): dad.VisibilityAccess {
  return {
    kind: "visibility",
    resourceType: token.entityWireName,
    permission: token.permissionName,
  };
}

/** Route cards delegate to the guarded Workbench operations. */
export function createWorkbenchRoutes(operations: WorkbenchOperations) {
  return dad.routeGroup("Workbench", [
    // @operation listWorkspaces
    dad.listRoute({
      path: "/api/workspaces",
      summary: "List visible workspaces",
      access: visible(workbenchWorkspace.permissions.view),
      query: listQuery,
      meta: listMeta,
      item: workspaceResponse,
      handler: ({ subject, visibleIds, query }) =>
        listOutcome(() =>
          operations.listWorkspaces(subject, visibleIds, query),
        ),
    }),
    // @operation createWorkspace
    dad.postRoute({
      path: "/api/workspaces",
      summary: "Create a workspace",
      access: { kind: "session" },
      body: createWorkspaceBody,
      response: workspaceResponse,
      handler: ({ subject, body }) =>
        routeOutcome(() => operations.createWorkspace(subject, body)),
    }),
    // @operation getWorkspace
    dad.getRoute({
      path: "/api/workspaces/:workspaceId",
      summary: "Read a workspace",
      access: requirePermission(
        workbenchWorkspace.permissions.view,
        "workspaceId",
      ),
      params: workspaceParams,
      response: workspaceResponse,
      handler: ({ subject, params }) =>
        routeOutcome(() =>
          operations.getWorkspace(subject, params.workspaceId),
        ),
    }),
    // @operation updateWorkspace
    dad.patchRoute({
      path: "/api/workspaces/:workspaceId",
      summary: "Update a workspace",
      access: requirePermission(
        workbenchWorkspace.permissions.manage,
        "workspaceId",
      ),
      params: workspaceParams,
      body: updateWorkspaceBody,
      response: workspaceResponse,
      handler: ({ subject, params, body }) =>
        routeOutcome(() =>
          operations.updateWorkspace(subject, params.workspaceId, body),
        ),
    }),
    // @operation deleteWorkspace
    dad.deleteRoute({
      path: "/api/workspaces/:workspaceId",
      summary: "Delete a workspace and its resources",
      access: requirePermission(
        workbenchWorkspace.permissions.manage,
        "workspaceId",
      ),
      params: workspaceParams,
      handler: ({ subject, params }) =>
        routeOutcome(() =>
          operations.deleteWorkspace(subject, params.workspaceId),
        ),
    }),
    // @operation listTasks
    dad.listRoute({
      path: "/api/workspaces/:workspaceId/tasks",
      summary: "List visible workspace tasks",
      access: { kind: "session" },
      params: workspaceParams,
      query: listQuery,
      meta: listMeta,
      item: taskResponse,
      handler: ({ subject, params, query }) =>
        listOutcome(() =>
          operations.listTasks(subject, params.workspaceId, undefined, query),
        ),
    }),
    // @operation createTask
    dad.postRoute({
      path: "/api/workspaces/:workspaceId/tasks",
      summary: "Create a task",
      access: requirePermission(
        workbenchWorkspace.permissions.manage,
        "workspaceId",
      ),
      params: workspaceParams,
      body: createTaskBody,
      response: taskResponse,
      handler: ({ subject, params, body }) =>
        routeOutcome(() =>
          operations.createTask(subject, params.workspaceId, body),
        ),
    }),
    // @operation getTask
    dad.getRoute({
      path: "/api/tasks/:taskId",
      summary: "Read a task",
      access: requirePermission(workbenchTask.permissions.view, "taskId"),
      params: taskParams,
      response: taskResponse,
      handler: ({ subject, params }) =>
        routeOutcome(() => operations.getTask(subject, params.taskId)),
    }),
    // @operation updateTask
    dad.patchRoute({
      path: "/api/tasks/:taskId",
      summary: "Update a task",
      access: requirePermission(workbenchTask.permissions.manage, "taskId"),
      params: taskParams,
      body: updateTaskBody,
      response: taskResponse,
      handler: ({ subject, params, body }) =>
        routeOutcome(() => operations.updateTask(subject, params.taskId, body)),
    }),
    // @operation deleteTask
    dad.deleteRoute({
      path: "/api/tasks/:taskId",
      summary: "Delete a task and its artifacts",
      access: requirePermission(workbenchTask.permissions.manage, "taskId"),
      params: taskParams,
      handler: ({ subject, params }) =>
        routeOutcome(() => operations.deleteTask(subject, params.taskId)),
    }),
    // @operation claimTask
    dad.postRoute({
      path: "/api/tasks/:taskId/claim",
      summary: "Claim an available task",
      access: requirePermission(workbenchTask.permissions.view, "taskId"),
      params: taskParams,
      body: claimTaskBody,
      response: taskResponse,
      handler: ({ subject, params }) =>
        routeOutcome(() => operations.claimTask(subject, params.taskId)),
    }),
    // @operation listMembers
    dad.listRoute({
      path: "/api/workspaces/:workspaceId/members",
      summary: "List workspace membership",
      access: { kind: "session" },
      params: workspaceParams,
      query: listQuery,
      meta: listMeta,
      item: memberResponse,
      handler: ({ subject, params, query }) =>
        listOutcome(() =>
          operations.listMembers(subject, params.workspaceId, undefined, query),
        ),
    }),
    // @operation grantMember
    dad.postRoute({
      path: "/api/workspaces/:workspaceId/members",
      summary: "Grant workspace membership",
      access: requirePermission(
        workbenchWorkspace.permissions.manage,
        "workspaceId",
      ),
      params: workspaceParams,
      body: grantMemberBody,
      response: memberResponse,
      handler: ({ subject, params, body }) =>
        routeOutcome(() =>
          operations.grantMember(subject, params.workspaceId, body.userId),
        ),
    }),
    // @operation revokeMember
    dad.deleteRoute({
      path: "/api/workspaces/:workspaceId/members/:userId",
      summary: "Revoke workspace membership",
      access: requirePermission(
        workbenchWorkspace.permissions.manage,
        "workspaceId",
      ),
      params: memberParams,
      handler: ({ subject, params }) =>
        routeOutcome(() =>
          operations.revokeMember(subject, params.workspaceId, params.userId),
        ),
    }),
    // @operation listArtifacts
    dad.listRoute({
      path: "/api/tasks/:taskId/artifacts",
      summary: "List visible task artifacts",
      access: { kind: "session" },
      params: taskParams,
      query: listQuery,
      meta: listMeta,
      item: artifactResponse,
      handler: ({ subject, params, query }) =>
        listOutcome(() =>
          operations.listArtifacts(subject, params.taskId, undefined, query),
        ),
    }),
    // @operation createArtifact
    dad.postRoute({
      path: "/api/tasks/:taskId/artifacts",
      summary: "Create a bounded text artifact",
      access: requirePermission(workbenchTask.permissions.manage, "taskId"),
      params: taskParams,
      body: createArtifactBody,
      response: artifactResponse,
      handler: ({ subject, params, body }) =>
        routeOutcome(() =>
          operations.createArtifact(subject, params.taskId, body),
        ),
    }),
    // @operation listActivity
    dad.listRoute({
      path: "/api/workspaces/:workspaceId/activity",
      summary: "List visible workspace activity",
      access: { kind: "session" },
      params: workspaceParams,
      query: listQuery,
      meta: listMeta,
      item: activityResponse,
      handler: ({ subject, params, query }) =>
        listOutcome(() =>
          operations.listActivity(
            subject,
            params.workspaceId,
            undefined,
            query,
          ),
        ),
    }),
    workbenchActivityStream(operations),
  ]);
}
