import {
  bindWorkbenchSubject,
  workbenchTarget,
  workbenchTask,
  workbenchWorkspace,
  type WorkbenchAuthorization,
  type WorkbenchRequestSubject,
  type WorkbenchSubject,
  type WorkbenchTaskIds,
} from "../access.js";
import type { ListQuery, Task } from "../contracts.js";
import { isSameStoreAuthorizingWorkbenchStore } from "../storage/workbench-store.js";
import { paginate, type OperationDependencies } from "./operation-coordinator.js";
import {
  checkWorkbenchPermission,
  checkWorkbenchPermissions,
  lookupWorkbenchResources,
} from "./workbench-authorization.js";

export async function listWorkspaceTasks(
  { authorization, store }: Pick<OperationDependencies, "authorization" | "store">,
  requestSubject: WorkbenchRequestSubject,
  workspaceId: string,
  allowedIds: WorkbenchTaskIds | undefined,
  query: ListQuery,
) {
  const subject = bindWorkbenchSubject(requestSubject);
  if (subject === undefined) return paginate([], query);
  const parent = {
    ...workbenchTarget(workbenchWorkspace.permissions.view, workspaceId),
    subject,
  };
  if (!(await checkWorkbenchPermission(authorization, parent))) return paginate([], query);

  const workspaceTasks = await store.readTaskCandidates(workspaceId);
  const requestedIds = allowedIds === undefined ? undefined : new Set(allowedIds);
  const candidates =
    requestedIds === undefined ? workspaceTasks : workspaceTasks.filter((task) => requestedIds.has(task.id));
  if (candidates.length === 0) return paginate([], query);

  const visible =
    allowedIds === undefined && isSameStoreAuthorizingWorkbenchStore(store)
      ? await discoverVisibleTasks(authorization, subject, candidates)
      : await checkTaskCandidates(authorization, subject, candidates);
  if (visible.length === 0) return paginate([], query);

  // Workspace access can change during the snapshot read or task authorization.
  if (!(await checkWorkbenchPermission(authorization, parent))) return paginate([], query);
  return paginate(visible, query);
}

async function discoverVisibleTasks(
  authorization: WorkbenchAuthorization,
  subject: WorkbenchSubject,
  candidates: readonly Task[],
) {
  const permission = workbenchTask.permissions.view;
  const visibleIds = new Set(
    await lookupWorkbenchResources(authorization, {
      subject,
      resourceType: permission.entityWireName,
      permission: permission.permissionName,
    }),
  );
  return candidates.filter((task) => visibleIds.has(task.id));
}

async function checkTaskCandidates(
  authorization: WorkbenchAuthorization,
  subject: WorkbenchSubject,
  candidates: readonly Task[],
) {
  const decisions = await checkWorkbenchPermissions(
    authorization,
    candidates.map((task) => ({
      ...workbenchTarget(workbenchTask.permissions.view, task.id),
      subject,
    })),
  );
  return candidates.filter((_task, index) => decisions[index] === true);
}
