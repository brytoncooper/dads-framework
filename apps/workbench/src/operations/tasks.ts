import { workbenchTarget, workbenchFact } from "../access.js";
import type {
  Artifact,
  CreateTask,
  ListQuery,
  Task,
  UpdateTask,
} from "../contracts.js";
import {
  workbenchTask,
  workbenchWorkspace,
  type WorkbenchRequestSubject,
  type WorkbenchTaskIds,
} from "../access.js";
import type { OperationCoordinator } from "./operation-coordinator.js";
import {
  findTask,
  findWorkspace,
  requireUser,
} from "./operation-coordinator.js";
import { WorkbenchError } from "./workbench-error.js";
import { findCreatedResource } from "./create-request.js";
import { listWorkspaceTasks } from "./list-workspace-tasks.js";

/** Every task but the deleted one. Named so the predicate is not a third nested callback. */
function tasksExcept(tasks: readonly Task[], taskId: string): Task[] {
  return tasks.filter((entry) => entry.id !== taskId);
}

/** Every artifact that does not belong to the deleted task. */
function artifactsOutsideTask(
  artifacts: readonly Artifact[],
  taskId: string,
): Artifact[] {
  return artifacts.filter((entry) => entry.taskId !== taskId);
}

export function taskOperations(coordinator: OperationCoordinator) {
  const { store, clock, createId } = coordinator.dependencies;
  return {
    createTask: (
      subject: WorkbenchRequestSubject,
      workspaceId: string,
      body: CreateTask,
    ) =>
      coordinator.run(async () => {
        return coordinator.create(
          subject,
          {
            subjectType: subject.type,
            subjectId: subject.id,
            operation: "createTask",
            parentId: workspaceId,
            requestKey: body.requestKey,
            payload: [body.title, body.description],
          },
          {
            kind: "protected-create",
            createTarget: workbenchTarget(
              workbenchWorkspace.permissions.manage,
              workspaceId,
            ),
            replayTarget: (state, id) => {
              findCreatedResource(state.tasks, id);
              return workbenchTarget(workbenchTask.permissions.manage, id);
            },
          },
          (state) => {
            findWorkspace(state, workspaceId);
            const now = clock();
            const task: Task = {
              id: createId(),
              workspaceId,
              title: body.title,
              description: body.description,
              status: "todo",
              claimedBy: null,
              createdAt: now,
              updatedAt: now,
            };
            state.tasks.push(task);
            coordinator.enqueue(state, "write", [
              workbenchFact(workbenchTask.roles.workspace, task.id, {
                type: workbenchWorkspace.entity.wireName,
                id: workspaceId,
              }),
            ]);
            coordinator.activity(
              state,
              subject,
              workspaceId,
              task.id,
              "task.created",
            );
            return task;
          },
          (state, id) => findCreatedResource(state.tasks, id),
        );
      }),
    listTasks: (
      subject: WorkbenchRequestSubject,
      workspaceId: string,
      allowedIds: WorkbenchTaskIds | undefined,
      query: ListQuery,
    ) =>
      coordinator.run(() =>
        listWorkspaceTasks(
          coordinator.dependencies,
          subject,
          workspaceId,
          allowedIds,
          query,
        ),
      ),
    getTask: (subject: WorkbenchRequestSubject, id: string) =>
      coordinator.run(async () => {
        await coordinator.requirePermission(
          subject,
          workbenchTarget(workbenchTask.permissions.view, id),
        );
        return findTask(await store.read(), id);
      }),
    updateTask: (
      subject: WorkbenchRequestSubject,
      id: string,
      body: UpdateTask,
    ) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchTask.permissions.manage, id),
          (state) => {
            const task = findTask(state, id);
            Object.assign(task, body, { updatedAt: clock() });
            coordinator.activity(
              state,
              subject,
              task.workspaceId,
              id,
              "task.updated",
            );
            return task;
          },
        );
      }),
    claimTask: (subject: WorkbenchRequestSubject, id: string) =>
      coordinator.run(async () => {
        requireUser(subject);
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchTask.permissions.view, id),
          (state) => {
            const task = findTask(state, id);
            if (task.claimedBy !== null && task.claimedBy !== subject.id)
              throw new WorkbenchError("CONFLICT");
            if (task.claimedBy === subject.id) return task;
            task.claimedBy = subject.id;
            task.status = "in_progress";
            task.updatedAt = clock();
            coordinator.activity(
              state,
              subject,
              task.workspaceId,
              id,
              "task.claimed",
            );
            return task;
          },
        );
      }),
    deleteTask: (subject: WorkbenchRequestSubject, id: string) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchTask.permissions.manage, id),
          (state) => {
            const task = findTask(state, id);
            state.tasks = tasksExcept(state.tasks, id);
            state.artifacts = artifactsOutsideTask(state.artifacts, id);
            coordinator.enqueue(state, "delete", [
              workbenchFact(workbenchTask.roles.workspace, id, {
                type: workbenchWorkspace.entity.wireName,
                id: task.workspaceId,
              }),
            ]);
            coordinator.activity(
              state,
              subject,
              task.workspaceId,
              id,
              "task.deleted",
            );
            return undefined;
          },
        );
      }),
  };
}
