import { workbenchTarget, workbenchFact } from "../access.js";
import type {
  CreateWorkspace,
  ListQuery,
  UpdateWorkspace,
  Workspace,
} from "../contracts.js";
import {
  workbenchTask,
  workbenchUser,
  workbenchWorkspace,
  type WorkbenchRelationship,
  type WorkbenchRequestSubject,
  type WorkbenchWorkspaceIds,
} from "../access.js";
import type { WorkbenchState } from "../storage/workbench-state.js";
import type { OperationCoordinator } from "./operation-coordinator.js";
import { findCreatedResource } from "./create-request.js";
import {
  findWorkspace,
  paginate,
  requireUser,
} from "./operation-coordinator.js";

/** Any row a workspace owns; deleting the workspace removes every one of them. */
type WorkspaceScoped = { readonly workspaceId: string };

/**
 * The exact relationships a workspace deletion removes: one per membership,
 * then one per task. Named so each predicate stays out of the mutation callback.
 */
function deletedWorkspaceRelationships(
  state: WorkbenchState,
  workspaceId: string,
): WorkbenchRelationship[] {
  const relationships: WorkbenchRelationship[] = [];
  for (const member of state.members.filter(
    (entry) => entry.workspaceId === workspaceId,
  )) {
    const user = { type: workbenchUser.wireName, id: member.userId };
    if (member.role === "owner")
      relationships.push(
        workbenchFact(workbenchWorkspace.roles.owner, workspaceId, user),
      );
    else
      relationships.push(
        workbenchFact(workbenchWorkspace.roles.member, workspaceId, user),
      );
  }
  for (const task of state.tasks.filter(
    (entry) => entry.workspaceId === workspaceId,
  )) {
    relationships.push(
      workbenchFact(workbenchTask.roles.workspace, task.id, {
        type: workbenchWorkspace.entity.wireName,
        id: workspaceId,
      }),
    );
  }
  return relationships;
}

/** Every workspace but the deleted one. */
function workspacesExcept(
  workspaces: readonly Workspace[],
  workspaceId: string,
): Workspace[] {
  return workspaces.filter((entry) => entry.id !== workspaceId);
}

/** Every row that does not belong to the deleted workspace. */
function outsideWorkspace<Row extends WorkspaceScoped>(
  rows: readonly Row[],
  workspaceId: string,
): Row[] {
  return rows.filter((entry) => entry.workspaceId !== workspaceId);
}

export function workspaceOperations(coordinator: OperationCoordinator) {
  const { store, clock, createId } = coordinator.dependencies;
  return {
    createWorkspace: (
      subject: WorkbenchRequestSubject,
      body: CreateWorkspace,
    ) =>
      coordinator.run(() => {
        const userSubject = requireUser(subject);
        return coordinator.create(
          subject,
          {
            subjectType: subject.type,
            subjectId: subject.id,
            operation: "createWorkspace",
            parentId: null,
            requestKey: body.requestKey,
            payload: [body.name, body.description],
          },
          {
            kind: "unprotected-workspace-create",
            createTarget: undefined,
            replayTarget: (state, id) => {
              findCreatedResource(state.workspaces, id);
              return workbenchTarget(workbenchWorkspace.permissions.manage, id);
            },
          },
          (state) => {
            const now = clock();
            const workspace: Workspace = {
              id: createId(),
              name: body.name,
              description: body.description,
              ownerId: subject.id,
              createdAt: now,
              updatedAt: now,
            };
            state.workspaces.push(workspace);
            state.members.push({
              workspaceId: workspace.id,
              userId: subject.id,
              role: "owner",
              createdAt: now,
            });
            coordinator.enqueue(state, "write", [
              workbenchFact(
                workbenchWorkspace.roles.owner,
                workspace.id,
                userSubject,
              ),
            ]);
            coordinator.activity(
              state,
              subject,
              workspace.id,
              workspace.id,
              "workspace.created",
            );
            return workspace;
          },
          (state, id) => findCreatedResource(state.workspaces, id),
        );
      }),
    listWorkspaces: (
      subject: WorkbenchRequestSubject,
      allowedIds: WorkbenchWorkspaceIds | undefined,
      query: ListQuery,
    ) =>
      coordinator.run(async () => {
        const visible = await coordinator.discoverWorkspaces(
          subject,
          workbenchWorkspace.permissions.view,
          allowedIds,
        );
        if (visible.length === 0) return paginate([], query);
        return paginate(await store.listWorkspaces(visible), query);
      }),
    getWorkspace: (subject: WorkbenchRequestSubject, id: string) =>
      coordinator.run(async () => {
        await coordinator.requirePermission(
          subject,
          workbenchTarget(workbenchWorkspace.permissions.view, id),
        );
        return findWorkspace(await store.read(), id);
      }),
    updateWorkspace: (
      subject: WorkbenchRequestSubject,
      id: string,
      body: UpdateWorkspace,
    ) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchWorkspace.permissions.manage, id),
          (state) => {
            const workspace = findWorkspace(state, id);
            Object.assign(workspace, body, { updatedAt: clock() });
            coordinator.activity(state, subject, id, id, "workspace.updated");
            return workspace;
          },
        );
      }),
    deleteWorkspace: (subject: WorkbenchRequestSubject, id: string) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchWorkspace.permissions.manage, id),
          (state) => {
            findWorkspace(state, id);
            const relationships = deletedWorkspaceRelationships(state, id);
            state.workspaces = workspacesExcept(state.workspaces, id);
            state.tasks = outsideWorkspace(state.tasks, id);
            state.members = outsideWorkspace(state.members, id);
            state.artifacts = outsideWorkspace(state.artifacts, id);
            state.activity = outsideWorkspace(state.activity, id);
            coordinator.enqueue(state, "delete", relationships);
            return undefined;
          },
        );
      }),
  };
}
