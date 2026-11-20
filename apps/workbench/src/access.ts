import {
  access,
  accessModel,
  asPermissionTerm,
  entityHandle,
  through,
  type PermissionToken,
  type RoleToken,
} from "@dads-framework/access";
import {
  type Authorization,
  type PermissionQuery,
  type RelationshipWrite,
} from "@dads-framework/authorization";

import { resourceId } from "./contracts.js";

export const workbenchUser = entityHandle({
  wireName: "user",
  idSchema: resourceId,
});
const workspaceEntity = entityHandle({
  wireName: "workspace",
  idSchema: resourceId,
  kind: "scope",
});
const taskEntity = entityHandle({
  wireName: "task",
  idSchema: resourceId,
  kind: "record",
});
const userDefinition = access(workbenchUser, {
  roles: {},
  permissions: () => ({}),
});
export const workbenchWorkspace = access(workspaceEntity, {
  roles: { owner: workbenchUser, member: workbenchUser },
  permissions: ({ owner, member }) => ({
    view: [asPermissionTerm([owner, member])],
    manage: [owner],
  }),
});
export const workbenchTask = access(taskEntity, {
  roles: { workspace: workspaceEntity },
  permissions: ({ workspace }) => ({
    view: [through(workspace, workbenchWorkspace.permissions.view)],
    manage: [through(workspace, workbenchWorkspace.permissions.manage)],
  }),
});

/** Task state, including claims, never grants independent access. */
export const workbenchAccessModel = accessModel([
  userDefinition,
  workbenchWorkspace,
  workbenchTask,
]);

export type WorkbenchAuthorization = Authorization;
export type WorkbenchRelationship = RelationshipWrite;
export type WorkbenchSubject = { readonly type: string; readonly id: string };
export type WorkbenchRequestSubject = WorkbenchSubject;
export type WorkbenchWorkspaceIds = readonly string[];
export type WorkbenchTaskIds = readonly string[];

export function bindWorkbenchSubject(
  subject: WorkbenchRequestSubject,
): WorkbenchSubject | undefined {
  const id = resourceId.safeParse(subject.id);
  return subject.type === workbenchUser.wireName && id.success
    ? { type: workbenchUser.wireName, id: id.data }
    : undefined;
}

export function workbenchTarget(
  token: PermissionToken,
  id: string,
): Omit<PermissionQuery, "subject"> {
  return {
    permission: token.permissionName,
    resource: { type: token.entityWireName, id },
  };
}

export function workbenchFact(
  role: RoleToken,
  id: string,
  subject: WorkbenchSubject,
): WorkbenchRelationship {
  return {
    resource: { type: role.entityWireName, id },
    relation: role.roleName,
    subject,
  };
}
