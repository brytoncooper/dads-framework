import type { ScimGroupData, ScimGroupMember } from "./group-directory.js";
import { parseMembers, parseScimGroup } from "./group-data.js";
import { parsePatchOperations, type PatchOperation } from "./patch-operations.js";
import { attributePath, attributes, groupSchema, ScimError } from "./protocol.js";

function mergeMembers(existing: readonly ScimGroupMember[], input: unknown): readonly ScimGroupMember[] {
  return [...new Map([...existing, ...parseMembers(input)].map((member) => [member.value, member])).values()];
}

function filterMember(path: string): string | undefined {
  const match = /^members\[\s*value\s+eq\s+("(?:[^"\\]|\\.)*")\s*\]$/i.exec(path);
  if (!match?.[1]) return undefined;
  try {
    const id: unknown = JSON.parse(match[1]);
    return typeof id === "string" ? id : undefined;
  } catch {
    throw new ScimError(400, "Invalid group membership filter.", "invalidPath");
  }
}

function removeSelectedMembers(group: ScimGroupData, selector: string, operation: PatchOperation): ScimGroupData {
  const memberId = filterMember(selector);
  if (memberId === undefined || operation.action === "add") {
    throw new ScimError(400, "Unsupported group membership path.", "invalidPath");
  }
  const members = group.members.filter((member) => member.value !== memberId);
  if (operation.action === "remove") return { ...group, members };
  if (members.length === group.members.length) throw new ScimError(400, "No matching group member.", "noTarget");
  return parseScimGroup({
    ...group,
    members: mergeMembers(members, operation.value),
  });
}

function changeGroupAttribute(group: ScimGroupData, path: string, operation: PatchOperation): ScimGroupData {
  const normal = attributePath(path, groupSchema);
  if (normal.startsWith("members[")) {
    // Attribute names are case-insensitive, while directory identifiers preserve case.
    const selector = path.trim().slice(path.trim().indexOf("["));
    return removeSelectedMembers(group, `members${selector}`, operation);
  }
  const field = {
    displayName: "displayname",
    externalId: "externalid",
    members: "members",
  };
  const key = Object.entries(field).find(([, name]) => name === normal)?.[0];
  if (["id", "schemas", "meta"].includes(normal)) {
    throw new ScimError(400, "The requested attribute is read-only.", "mutability");
  }
  if (!key) throw new ScimError(400, "Unsupported group operation path.", "invalidPath");
  if (key === "displayName" && operation.action === "remove") {
    throw new ScimError(400, "displayName is required.", "mutability");
  }
  if (key === "members") return changeMembers(group, operation);
  return parseScimGroup({
    ...group,
    [key]: operation.action === "remove" ? undefined : operation.value,
  });
}

function changeMembers(group: ScimGroupData, operation: PatchOperation): ScimGroupData {
  if (operation.action === "add") {
    return parseScimGroup({
      ...group,
      members: mergeMembers(group.members, operation.value),
    });
  }
  if (operation.action === "replace") {
    return parseScimGroup({ ...group, members: operation.value });
  }
  if (operation.value === undefined) return { ...group, members: [] };
  const removed = new Set(parseMembers(operation.value).map((member) => member.value));
  return {
    ...group,
    members: group.members.filter((member) => !removed.has(member.value)),
  };
}

function applyGroupOperation(group: ScimGroupData, operation: PatchOperation): ScimGroupData {
  if (operation.path !== undefined) return changeGroupAttribute(group, operation.path, operation);
  return Object.entries(attributes(operation.value)).reduce(
    (current, [path, value]) => changeGroupAttribute(current, path, { ...operation, value }),
    group,
  );
}

export function compileGroupPatch(body: Record<string, unknown>): (group: ScimGroupData) => ScimGroupData {
  const operations = parsePatchOperations(body);
  return (group) => operations.reduce(applyGroupOperation, group);
}
