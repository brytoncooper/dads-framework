import { workbenchTarget, workbenchFact } from "../access.js";
import type { ListQuery, Member } from "../contracts.js";
import {
  workbenchUser,
  workbenchWorkspace,
  type WorkbenchRequestSubject,
  type WorkbenchWorkspaceIds,
} from "../access.js";
import type { OperationCoordinator } from "./operation-coordinator.js";
import { findWorkspace, paginate } from "./operation-coordinator.js";
import { WorkbenchError } from "./workbench-error.js";

/** The one membership row for a user in a workspace, if it exists. */
function findMembership(members: readonly Member[], workspaceId: string, userId: string): Member | undefined {
  return members.find((member) => member.workspaceId === workspaceId && member.userId === userId);
}

/** Every membership row except the revoked one. */
function membershipsExcept(members: readonly Member[], workspaceId: string, userId: string): Member[] {
  return members.filter((member) => member.workspaceId !== workspaceId || member.userId !== userId);
}

export function memberOperations(coordinator: OperationCoordinator) {
  const { store, clock } = coordinator.dependencies;
  return {
    listMembers: (
      subject: WorkbenchRequestSubject,
      workspaceId: string,
      allowedIds: WorkbenchWorkspaceIds | undefined,
      query: ListQuery,
    ) =>
      coordinator.run(async () => {
        const visible = await coordinator.allowedIds(
          subject,
          workbenchWorkspace.permissions.manage,
          allowedIds ?? [workspaceId],
        );
        if (visible.length === 0) return paginate([], query);
        return paginate(await store.listMembers(workspaceId, visible), query);
      }),
    grantMember: (subject: WorkbenchRequestSubject, workspaceId: string, userId: string) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchWorkspace.permissions.manage, workspaceId),
          (state) => {
            findWorkspace(state, workspaceId);
            const existing = findMembership(state.members, workspaceId, userId);
            if (existing) return existing;
            const member: Member = {
              workspaceId,
              userId,
              role: "member",
              createdAt: clock(),
            };
            state.members.push(member);
            coordinator.enqueue(state, "write", [
              workbenchFact(workbenchWorkspace.roles.member, workspaceId, {
                type: workbenchUser.wireName,
                id: userId,
              }),
            ]);
            coordinator.activity(state, subject, workspaceId, userId, "member.granted");
            return member;
          },
        );
      }),
    revokeMember: (subject: WorkbenchRequestSubject, workspaceId: string, userId: string) =>
      coordinator.run(async () => {
        return coordinator.authorizedChange(
          subject,
          workbenchTarget(workbenchWorkspace.permissions.manage, workspaceId),
          (state) => {
            const workspace = findWorkspace(state, workspaceId);
            if (workspace.ownerId === userId) throw new WorkbenchError("CONFLICT");
            const existing = findMembership(state.members, workspaceId, userId) !== undefined;
            state.members = membershipsExcept(state.members, workspaceId, userId);
            coordinator.enqueue(state, "delete", [
              workbenchFact(workbenchWorkspace.roles.member, workspaceId, {
                type: workbenchUser.wireName,
                id: userId,
              }),
            ]);
            if (existing) coordinator.activity(state, subject, workspaceId, userId, "member.revoked");
            return undefined;
          },
        );
      }),
  };
}
