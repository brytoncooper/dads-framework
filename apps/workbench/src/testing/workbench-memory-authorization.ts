import type {
  PermissionQuery,
  RelationshipFilter,
  ResourceLookup,
} from "@dads-framework/spicedb-access";
import { FakeAuthorization } from "@dads-framework/spicedb-access/testing";
import {
  workbenchTask,
  workbenchWorkspace,
  type WorkbenchRelationship,
} from "../access.js";

const workspaceType = workbenchWorkspace.wireName;
const taskType = workbenchTask.wireName;
const parent = workbenchTask.roles.workspace.roleName;
const workspacePermissions = {
  [workbenchWorkspace.permissions.view.permissionName]: [
    workbenchWorkspace.roles.owner.roleName,
    workbenchWorkspace.roles.member.roleName,
  ],
  [workbenchWorkspace.permissions.manage.permissionName]: [
    workbenchWorkspace.roles.owner.roleName,
  ],
};

/** A small Workbench graph substitute. Real backend parity is tested separately. */
export class WorkbenchMemoryAuthorization extends FakeAuthorization {
  constructor() {
    super({ [workspaceType]: workspacePermissions });
  }

  override async check(query: PermissionQuery): Promise<boolean> {
    if (query.resource.type !== taskType) return super.check(query);
    const workspaces = await this.listDirectSubjects({
      resource: query.resource,
      relation: parent,
    });
    const decisions = await Promise.all(
      workspaces.map((workspace) =>
        super.check({
          subject: query.subject,
          permission: query.permission,
          resource: workspace,
        }),
      ),
    );
    return decisions.some(Boolean);
  }

  override async lookupResources(
    query: ResourceLookup,
  ): Promise<readonly string[]> {
    if (query.resourceType !== taskType) return super.lookupResources(query);
    const parents = await super.lookupResources({
      ...query,
      resourceType: workspaceType,
    });
    const tasks = await Promise.all(
      parents.map((id) =>
        super.lookupResources({
          resourceType: taskType,
          permission: parent,
          subject: { type: workspaceType, id },
        }),
      ),
    );
    return [...new Set(tasks.flat())];
  }

  async deleteExact(
    ...relationships: readonly WorkbenchRelationship[]
  ): Promise<void> {
    for (const relationship of relationships)
      await this.deleteRelationships(relationshipFilter(relationship));
  }

  async hasTuple(relationship: WorkbenchRelationship): Promise<boolean> {
    const subjects = await this.listDirectSubjects(relationship);
    return subjects.some(
      (subject) =>
        subject.type === relationship.subject.type &&
        subject.id === relationship.subject.id &&
        subject.relation === relationship.subject.relation,
    );
  }
}

export function relationshipFilter(
  relationship: WorkbenchRelationship,
): RelationshipFilter {
  return {
    resourceType: relationship.resource.type,
    resourceId: relationship.resource.id,
    relation: relationship.relation,
    subject: relationship.subject,
  };
}
