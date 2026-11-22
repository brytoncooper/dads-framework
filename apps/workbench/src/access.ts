import {
  actor,
  compileAccess,
  resource,
  type ActorRef,
  type DslResource,
  type PermissionToken,
  type ResourceSubjectRef,
  type RoleToken,
} from "@dads-framework/access";
import {
  type Authorization,
  type PermissionQuery,
  type RelationshipWrite,
} from "@dads-framework/authorization";

import { resourceId } from "./contracts.js";

type WorkbenchTaskResource = DslResource<
  "task",
  { readonly workspace: ResourceSubjectRef<"workspace"> },
  "view" | "manage"
>;

type WorkbenchWorkspaceResource = DslResource<
  "workspace",
  { readonly owner: ActorRef<"user">; readonly member: ActorRef<"user"> },
  "view" | "manage",
  { readonly task: WorkbenchTaskResource }
>;

export const workbenchUser = actor("user", { id: resourceId });

export const workbenchWorkspace: WorkbenchWorkspaceResource = resource(
  "workspace",
  {
    id: resourceId,
    kind: "scope",
    roles: {
      owner: workbenchUser,
      member: workbenchUser,
    },
    can: ({ owner, member }) => ({
      view: [owner, member],
      manage: owner,
    }),
    children: {
      task: {
        id: resourceId,
        kind: "record",
        inherit: "all",
      },
    },
  },
);

export const workbenchTask: WorkbenchTaskResource = workbenchWorkspace.task;

/** Task state, including claims, never grants independent access. */
export const workbenchAccessModel = compileAccess([workbenchWorkspace]);

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
