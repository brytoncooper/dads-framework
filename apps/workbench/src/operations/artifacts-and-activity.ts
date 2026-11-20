import { workbenchTarget } from "../access.js";
import type { Artifact, CreateArtifact, ListQuery } from "../contracts.js";
import {
  workbenchTask,
  workbenchWorkspace,
  type WorkbenchRequestSubject,
  type WorkbenchTaskIds,
  type WorkbenchWorkspaceIds,
} from "../access.js";
import type { OperationCoordinator } from "./operation-coordinator.js";
import { findTask, paginate } from "./operation-coordinator.js";
import { findCreatedResource } from "./create-request.js";

export function artifactAndActivityOperations(
  coordinator: OperationCoordinator,
) {
  const { store, clock, createId } = coordinator.dependencies;
  return {
    createArtifact: (
      subject: WorkbenchRequestSubject,
      taskId: string,
      body: CreateArtifact,
    ) =>
      coordinator.run(async () => {
        return coordinator.create(
          subject,
          {
            subjectType: subject.type,
            subjectId: subject.id,
            operation: "createArtifact",
            parentId: taskId,
            requestKey: body.requestKey,
            payload: [body.name, body.content],
          },
          {
            kind: "protected-create",
            createTarget: workbenchTarget(
              workbenchTask.permissions.manage,
              taskId,
            ),
            replayTarget: (state, id) => {
              findCreatedResource(state.artifacts, id);
              return workbenchTarget(workbenchTask.permissions.manage, taskId);
            },
          },
          (state) => {
            const task = findTask(state, taskId);
            const artifact: Artifact = {
              id: createId(),
              workspaceId: task.workspaceId,
              taskId,
              name: body.name,
              content: body.content,
              createdBy: subject.id,
              createdAt: clock(),
            };
            state.artifacts.push(artifact);
            coordinator.activity(
              state,
              subject,
              task.workspaceId,
              artifact.id,
              "artifact.created",
            );
            return artifact;
          },
          (state, id) => findCreatedResource(state.artifacts, id),
        );
      }),
    listArtifacts: (
      subject: WorkbenchRequestSubject,
      taskId: string,
      allowedIds: WorkbenchTaskIds | undefined,
      query: ListQuery,
    ) =>
      coordinator.run(async () => {
        const visible = await coordinator.allowedIds(
          subject,
          workbenchTask.permissions.view,
          allowedIds ?? [taskId],
        );
        if (visible.length === 0) return paginate([], query);
        return paginate(await store.listArtifacts(taskId, visible), query);
      }),
    listActivity: (
      subject: WorkbenchRequestSubject,
      workspaceId: string,
      allowedIds: WorkbenchWorkspaceIds | undefined,
      query: ListQuery,
    ) =>
      coordinator.run(async () => {
        const visible = await coordinator.allowedIds(
          subject,
          workbenchWorkspace.permissions.view,
          allowedIds ?? [workspaceId],
        );
        if (visible.length === 0) return paginate([], query);
        return paginate(await store.listActivity(workspaceId, visible), query);
      }),
  };
}
