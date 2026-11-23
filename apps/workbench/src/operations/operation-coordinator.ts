import type { PermissionToken } from "@dads-framework/access";
import {
  bindWorkbenchSubject,
  workbenchTarget,
  type WorkbenchRequestSubject,
  type WorkbenchAuthorization,
  type WorkbenchRelationship,
} from "../access.js";
import type { Activity, ListQuery } from "../contracts.js";
import {
  pendingAuthorizationChange,
  type PendingAuthorizationChange,
  type WorkbenchState,
} from "../storage/workbench-state.js";
import type { WorkbenchMutation, WorkbenchPermissionTarget, WorkbenchStore } from "../storage/workbench-store.js";
import { isSameStoreAuthorizingWorkbenchStore } from "../storage/workbench-store.js";
import {
  applyWorkbenchRelationships,
  checkWorkbenchPermission,
  lookupWorkbenchResources,
  workbenchAuthorizationReadError,
} from "./workbench-authorization.js";
import { WorkbenchError } from "./workbench-error.js";
import { findCreateRequest, requireCreateCapacity, type CreateRequest } from "./create-request.js";

export type OperationDependencies = {
  readonly store: WorkbenchStore;
  readonly authorization: WorkbenchAuthorization;
  readonly clock: () => string;
  readonly createId: () => string;
};

type CreateAuthorization =
  | {
      /** A new workspace has no resource to authorize yet; its replay is always protected. */
      readonly kind: "unprotected-workspace-create";
      readonly createTarget: undefined;
      readonly replayTarget: (state: WorkbenchState, resourceId: string) => WorkbenchPermissionTarget;
    }
  | {
      readonly kind: "protected-create";
      readonly createTarget: WorkbenchPermissionTarget;
      readonly replayTarget: (state: WorkbenchState, resourceId: string) => WorkbenchPermissionTarget;
    };

/** Serializes checks and changes in the one local app process; the durable queue survives a restart. */
export class OperationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private capturedAuthorizationChanges: PendingAuthorizationChange[] | undefined;

  constructor(readonly dependencies: OperationDependencies) {}

  run<Result>(action: () => Result | Promise<Result>): Promise<Result> {
    const current = this.tail.then(async () => {
      await this.applyPendingRelationships();
      return action();
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  synchronize(): Promise<void> {
    return this.run(() => undefined);
  }

  async change<Result>(mutation: (state: WorkbenchState) => Result): Promise<Result> {
    const result = await this.dependencies.store.commitMutation((state) => this.captureMutation(state, mutation));
    await this.applyPendingRelationships();
    return result;
  }

  /** Uses the one-store path when available; legacy stores keep the check, outbox, and dispatch sequence. */
  async authorizedChange<Result>(
    subject: WorkbenchRequestSubject,
    target: WorkbenchPermissionTarget,
    mutation: (state: WorkbenchState) => Result,
  ): Promise<Result> {
    const boundSubject = requireUser(subject);
    const { store } = this.dependencies;
    if (isSameStoreAuthorizingWorkbenchStore(store))
      return store.commitAuthorizedMutation({
        subject: boundSubject,
        authorization: {
          kind: "protected",
          target: () => target,
        },
        mutation: (state) => this.captureMutation(state, mutation),
      });

    await this.requirePermission(subject, target);
    return this.change(mutation);
  }

  async create<Result extends { readonly id: string }>(
    subject: WorkbenchRequestSubject,
    request: CreateRequest,
    authorization: CreateAuthorization,
    mutation: (state: WorkbenchState) => Result,
    replay: (state: WorkbenchState, resourceId: string) => Result,
  ): Promise<Result> {
    const boundSubject = requireUser(subject);
    const { store } = this.dependencies;
    if (isSameStoreAuthorizingWorkbenchStore(store))
      return store.commitAuthorizedMutation({
        subject: boundSubject,
        authorization: {
          kind: "fresh-create",
          target: (state) => {
            const previous = findCreateRequest(state, request);
            return previous ? authorization.replayTarget(state, previous.resourceId) : authorization.createTarget;
          },
        },
        mutation: (state) => {
          const previous = findCreateRequest(state, request);
          if (previous)
            return {
              result: replay(state, previous.resourceId),
              authorizationChanges: [],
            };
          requireCreateCapacity(state);
          return this.captureMutation(state, (next) => {
            const resource = mutation(next);
            next.createRequests.push({ ...request, resourceId: resource.id });
            return resource;
          });
        },
      });

    const state = await store.read();
    const previous = findCreateRequest(state, request);
    if (previous) {
      await this.requirePermission(subject, authorization.replayTarget(state, previous.resourceId));
      return replay(state, previous.resourceId);
    }
    if (authorization.createTarget) await this.requirePermission(subject, authorization.createTarget);
    requireCreateCapacity(state);
    return this.change((next) => {
      const resource = mutation(next);
      next.createRequests.push({ ...request, resourceId: resource.id });
      return resource;
    });
  }

  async requirePermission(subject: WorkbenchRequestSubject, target: WorkbenchPermissionTarget): Promise<void> {
    const boundSubject = requireUser(subject);
    if (
      !(await checkWorkbenchPermission(this.dependencies.authorization, {
        ...target,
        subject: boundSubject,
      }))
    ) {
      throw new WorkbenchError("NOT_FOUND");
    }
  }

  async allowedIds(
    subject: WorkbenchRequestSubject,
    permission: PermissionToken,
    candidates: readonly string[],
  ): Promise<readonly string[]> {
    const bound = bindWorkbenchSubject(subject);
    if (bound === undefined) return [];
    const decisions = await Promise.all(
      candidates.map((id) =>
        checkWorkbenchPermission(this.dependencies.authorization, {
          ...workbenchTarget(permission, id),
          subject: bound,
        }),
      ),
    );
    return candidates.filter((_id, index) => decisions[index] === true);
  }

  async discoverWorkspaces(
    subject: WorkbenchRequestSubject,
    permission: PermissionToken,
    candidates: readonly string[] | undefined,
  ): Promise<readonly string[]> {
    const bound = bindWorkbenchSubject(subject);
    if (bound === undefined) return [];
    const visible = await lookupWorkbenchResources(this.dependencies.authorization, {
      subject: bound,
      resourceType: permission.entityWireName,
      permission: permission.permissionName,
    });
    if (candidates === undefined) return visible;
    const allowed = new Set(visible);
    return candidates.filter((id) => allowed.has(id));
  }

  enqueue(_state: WorkbenchState, action: "write" | "delete", relationships: readonly WorkbenchRelationship[]): void {
    if (relationships.length === 0) return;
    const changeSet = pendingAuthorizationChange.parse({
      version: 1,
      operationId: this.dependencies.createId(),
      writes: action === "write" ? relationships : [],
      deletes: action === "delete" ? relationships : [],
    });
    const captured = this.capturedAuthorizationChanges;
    if (!captured) throw new Error("Workbench authorization changes must be attached to a storage mutation.");
    captured.push(changeSet);
  }

  activity(
    state: WorkbenchState,
    subject: WorkbenchRequestSubject,
    workspaceId: string,
    resourceId: string,
    action: Activity["action"],
  ): void {
    state.activity.push({
      id: this.dependencies.createId(),
      workspaceId,
      actorId: subject.id,
      resourceId,
      action,
      createdAt: this.dependencies.clock(),
    });
  }

  private async applyPendingRelationships(): Promise<void> {
    const { authorization, store } = this.dependencies;
    if (isSameStoreAuthorizingWorkbenchStore(store)) return;
    for (const change of (await store.read()).pendingAuthorizationChanges) {
      try {
        await applyWorkbenchRelationships(authorization, change);
      } catch (cause) {
        if (workbenchAuthorizationReadError(cause) instanceof WorkbenchError) {
          throw new WorkbenchError("RELATIONSHIPS_PENDING", { cause });
        }
        throw cause;
      }
      await store.transaction((state) => {
        state.pendingAuthorizationChanges = state.pendingAuthorizationChanges.filter(
          (pending) => pending.operationId !== change.operationId,
        );
      });
    }
  }

  private captureMutation<Result>(
    state: WorkbenchState,
    mutation: (state: WorkbenchState) => Result,
  ): WorkbenchMutation<Result> {
    if (this.capturedAuthorizationChanges) throw new Error("Workbench storage mutations cannot be nested.");
    const authorizationChanges: PendingAuthorizationChange[] = [];
    this.capturedAuthorizationChanges = authorizationChanges;
    try {
      return { result: mutation(state), authorizationChanges };
    } finally {
      this.capturedAuthorizationChanges = undefined;
    }
  }
}

export function paginate<Item>(items: readonly Item[], query: ListQuery) {
  const start = (query.page - 1) * query.perPage;
  return {
    data: items.slice(start, start + query.perPage),
    meta: {
      page: query.page,
      perPage: query.perPage,
      total: items.length,
      pageCount: Math.ceil(items.length / query.perPage),
    },
  };
}

export function requireUser(subject: WorkbenchRequestSubject) {
  const boundSubject = bindWorkbenchSubject(subject);
  if (!boundSubject) throw new WorkbenchError("NOT_FOUND");
  return boundSubject;
}

export function findWorkspace(state: WorkbenchState, id: string) {
  const workspace = state.workspaces.find((entry) => entry.id === id);
  if (!workspace) throw new WorkbenchError("NOT_FOUND");
  return workspace;
}

export function findTask(state: WorkbenchState, id: string) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) throw new WorkbenchError("NOT_FOUND");
  return task;
}
