import type { ScimGroupData, ScimGroupMember } from "./group-directory.js";
import { attributes, isArray, ScimError } from "./protocol.js";
import { userString } from "./user-data.js";

export const maxGroupMembers = 1000;

function readMember(value: unknown): ScimGroupMember {
  const fields = attributes(value);
  const id = userString(fields["value"]);
  const type = userString(fields["type"]);
  if (!id?.trim() || (type !== undefined && type.toLowerCase() !== "user")) {
    throw new ScimError(
      400,
      "Group members must reference users.",
      "invalidValue",
    );
  }
  return { value: id };
}

export function parseMembers(value: unknown): readonly ScimGroupMember[] {
  if (value === undefined || value === null) return [];
  if (!isArray(value) || value.length > maxGroupMembers) {
    throw new ScimError(400, "Invalid group members list.", "invalidValue");
  }
  return [
    ...new Map(
      value.map((item) => {
        const member = readMember(item);
        return [member.value, member];
      }),
    ).values(),
  ];
}

export function parseScimGroup(value: unknown): ScimGroupData {
  const fields = attributes(value);
  const displayName = userString(fields["displayname"]);
  const externalId = userString(fields["externalid"]);
  if (!displayName?.trim())
    throw new ScimError(400, "Group displayName is required.", "invalidValue");
  return {
    displayName,
    ...(externalId === undefined ? {} : { externalId }),
    members: parseMembers(fields["members"]),
  };
}
