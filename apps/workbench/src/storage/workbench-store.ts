import type { PermissionQuery } from "@dads-framework/spicedb-access";
import type {
  WorkbenchSubject,
  WorkbenchTaskIds,
  WorkbenchWorkspaceIds,
} from "../access.js";
import type {
  Activity,
  Artifact,
  Member,
  Task,
  Workspace,
} from "../contracts.js";
import {
  storeWorkbenchAuthorizationChange,
  type WorkbenchState,
  type PendingAuthorizationChange,
} from "./workbench-state.js";

/** One domain mutation and its exact relationship projection form one storage-owned commit request. */
export type WorkbenchMutation<Result> = {
  readonly result: Result;
  readonly authorizationChanges: readonly PendingAuthorizationChange[];
};

export type WorkbenchPermissionTarget = Omit<PermissionQuery, "subject">;

type ProtectedSameStoreAuthorization = {
  readonly kind: "protected";
  readonly target: (state: WorkbenchState) => WorkbenchPermissionTarget;
};

type FreshCreateSameStoreAuthorization = {
  /** Only a brand-new workspace can resolve no authorization target. Replays always resolve one. */
  readonly kind: "fresh-create";
  readonly target: (
    state: WorkbenchState,
  ) => WorkbenchPermissionTarget | undefined;
};

/** An authorization decision evaluated under the same lock as a domain mutation. */
export type SameStoreMutationAuthorization =
  ProtectedSameStoreAuthorization | FreshCreateSameStoreAuthorization;

/** One protected mutation without a check-then-write gap or an authorization outbox. */
export type SameStoreAuthorizedWorkbenchMutation<Result> = {
  readonly subject: WorkbenchSubject;
  readonly authorization: SameStoreMutationAuthorization;
  readonly mutation: (state: WorkbenchState) => WorkbenchMutation<Result>;
};

/**
 * Optional store capability for a database that owns both Workbench state and
 * authorization tuples. Legacy stores retain the snapshot-and-outbox path.
 */
export type SameStoreAuthorizingWorkbenchStore = {
  commitAuthorizedMutation<Result>(
    request: SameStoreAuthorizedWorkbenchMutation<Result>,
  ): Promise<Result>;
};

/** Narrows the optional same-store capability without changing the legacy store contract. */
export function isSameStoreAuthorizingWorkbenchStore(
  store: WorkbenchStore,
): store is WorkbenchStore & SameStoreAuthorizingWorkbenchStore {
  return (
    "commitAuthorizedMutation" in store &&
    typeof store.commitAuthorizedMutation === "function"
  );
}

/** Owns application persistence; every snapshot is detached and each change commits atomically. */
export type WorkbenchStore = {
  read(): Promise<WorkbenchState>;
  /** Candidate records still require individual task authorization. */
  readTaskCandidates(workspaceId: string): Promise<readonly Task[]>;
  transaction<Result>(
    change: (state: WorkbenchState) => Result,
  ): Promise<Result>;
  commitMutation<Result>(
    mutation: (state: WorkbenchState) => WorkbenchMutation<Result>,
  ): Promise<Result>;
  listWorkspaces(
    allowedIds: WorkbenchWorkspaceIds,
  ): Promise<readonly Workspace[]>;
  listTasks(
    workspaceId: string,
    allowedIds: WorkbenchTaskIds,
  ): Promise<readonly Task[]>;
  listMembers(
    workspaceId: string,
    allowedWorkspaceIds: WorkbenchWorkspaceIds,
  ): Promise<readonly Member[]>;
  listArtifacts(
    taskId: string,
    allowedTaskIds: WorkbenchTaskIds,
  ): Promise<readonly Artifact[]>;
  listActivity(
    workspaceId: string,
    allowedWorkspaceIds: WorkbenchWorkspaceIds,
  ): Promise<readonly Activity[]>;
};

/** Collection selection always requires IDs supplied by authorization, including an empty set. */
export abstract class SnapshotWorkbenchStore implements WorkbenchStore {
  abstract read(): Promise<WorkbenchState>;
  abstract transaction<Result>(
    change: (state: WorkbenchState) => Result,
  ): Promise<Result>;

  async commitMutation<Result>(
    mutation: (state: WorkbenchState) => WorkbenchMutation<Result>,
  ): Promise<Result> {
    return this.transaction((state) => {
      const committed = mutation(state);
      state.pendingAuthorizationChanges.push(
        ...committed.authorizationChanges.map(
          storeWorkbenchAuthorizationChange,
        ),
      );
      return committed.result;
    });
  }

  async listWorkspaces(allowedIds: WorkbenchWorkspaceIds) {
    return (await this.read()).workspaces.filter((workspace) =>
      allowedIds.includes(workspace.id),
    );
  }
  async readTaskCandidates(workspaceId: string): Promise<readonly Task[]> {
    return (await this.read()).tasks.filter(
      (task) => task.workspaceId === workspaceId,
    );
  }

  async listTasks(workspaceId: string, allowedIds: WorkbenchTaskIds) {
    return (await this.read()).tasks.filter(
      (task) =>
        task.workspaceId === workspaceId && allowedIds.includes(task.id),
    );
  }
  async listMembers(
    workspaceId: string,
    allowedWorkspaceIds: WorkbenchWorkspaceIds,
  ) {
    return (await this.read()).members.filter(
      (member) =>
        member.workspaceId === workspaceId &&
        allowedWorkspaceIds.includes(workspaceId),
    );
  }
  async listArtifacts(taskId: string, allowedTaskIds: WorkbenchTaskIds) {
    return (await this.read()).artifacts.filter(
      (artifact) =>
        artifact.taskId === taskId && allowedTaskIds.includes(taskId),
    );
  }
  async listActivity(
    workspaceId: string,
    allowedWorkspaceIds: WorkbenchWorkspaceIds,
  ) {
    return (await this.read()).activity
      .filter(
        (event) =>
          event.workspaceId === workspaceId &&
          allowedWorkspaceIds.includes(workspaceId),
      )
      .reverse();
  }
}
