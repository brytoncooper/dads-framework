import {
  actor,
  compileAccess,
  permissionToken,
  resource,
  roleToken,
  type AnyDslResource,
  type DslNode,
} from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/spicedb-access";

export function makeChain(depth: number, count: number, membership: "direct" | "usersets" = "direct") {
  const user = actor("user");
  const groupMemberRef = roleToken("benchmark/group", "member", user.handle);
  const group = resource("benchmark/group", {
    roles: {
      member: membership === "direct" ? user : [user, user.anyone, groupMemberRef],
    },
    can: ({ member }) => ({ view: member }),
  });

  const nodes: DslNode[] = [user, group];
  const subject = { type: user.wireName, id: "actor" };
  const facts: RelationshipWrite[] = [
    {
      resource: { type: group.wireName, id: "parent" },
      relation: group.roles.member.roleName,
      subject,
    },
  ];

  let previous: AnyDslResource = group;

  for (let level = 1; level <= depth; level += 1) {
    const parentNode = previous;
    const wireName = `benchmark/level_${String(level)}`;
    const current = resource(wireName, {
      roles: { parent: parentNode },
      can: ({ parent }) => ({
        view: {
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken(parentNode.wireName, "view"),
        },
      }),
    });
    nodes.push(current);
    facts.push(...links(wireName, previous.wireName, level === depth ? count : 1));
    previous = current;
  }

  const check: PermissionQuery = {
    resource: { type: previous.wireName, id: "parent" },
    permission: "view",
    subject,
  };
  return { model: compileAccess(nodes), facts, check };
}

function links(resourceType: string, parentType: string, count: number): readonly RelationshipWrite[] {
  return Array.from({ length: count }, (_, index) => ({
    resource: {
      type: resourceType,
      id: index === 0 ? "parent" : `node_${String(index)}`,
    },
    relation: "parent",
    subject: { type: parentType, id: "parent" },
  }));
}
