import {
  access,
  accessModel,
  entityHandle,
  membersOf,
  roleToken,
  wildcard,
  through,
  type AccessDefinition,
  type EntityHandle,
  type PermissionToken,
} from "@dads-framework/access";
import type {
  PermissionQuery,
  RelationshipWrite,
} from "@dads-framework/authorization";
import { z } from "zod";

const idSchema = z.string();

export function makeChain(
  depth: number,
  count: number,
  membership: "direct" | "usersets" = "direct",
) {
  const user = entityHandle({ wireName: "user", idSchema });
  const group = entityHandle({ wireName: "benchmark/group", idSchema });
  const userAccess = access(user, { roles: {}, permissions: () => ({}) });
  const groupAccess = access(group, {
    roles: {
      member:
        membership === "direct"
          ? user
          : [
              user,
              wildcard(user),
              membersOf(roleToken(group.wireName, "member", user)),
            ],
    },
    permissions: ({ member }) => ({ view: [member] }),
  });
  const definitions: AccessDefinition<unknown, unknown>[] = [
    userAccess,
    groupAccess,
  ];
  const subject = { type: user.wireName, id: "actor" };
  const facts: RelationshipWrite[] = [
    {
      resource: { type: group.wireName, id: "parent" },
      relation: groupAccess.roles.member.roleName,
      subject,
    },
  ];
  let previous: { entity: EntityHandle; view: PermissionToken } = {
    entity: group,
    view: groupAccess.permissions.view,
  };

  for (let level = 1; level <= depth; level += 1) {
    const node = makeNode(level, previous);
    definitions.push(node);
    facts.push(...links(node, previous.entity, level === depth ? count : 1));
    previous = { entity: node.entity, view: node.permissions.view };
  }
  const check: PermissionQuery = {
    resource: { type: previous.entity.wireName, id: "parent" },
    permission: previous.view.permissionName,
    subject,
  };
  return { model: accessModel(definitions), facts, check };
}

function makeNode(
  level: number,
  previous: { entity: EntityHandle; view: PermissionToken },
) {
  const node = entityHandle({
    wireName: `benchmark/level_${String(level)}`,
    idSchema,
  });
  return access(node, {
    roles: { parent: previous.entity },
    permissions: ({ parent }) => ({ view: [through(parent, previous.view)] }),
  });
}

function links(
  node: ReturnType<typeof makeNode>,
  parent: EntityHandle,
  count: number,
): readonly RelationshipWrite[] {
  return Array.from({ length: count }, (_, index) => ({
    resource: {
      type: node.entity.wireName,
      id: index === 0 ? "parent" : `node_${String(index)}`,
    },
    relation: node.roles.parent.roleName,
    subject: { type: parent.wireName, id: "parent" },
  }));
}
