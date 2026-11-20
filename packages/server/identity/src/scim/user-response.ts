import type { ScimUser } from "./directory.js";
import { userSchema } from "./protocol.js";
import { createResourceProjection } from "./resource-projection.js";

export function createUserProjection(
  parameters: URLSearchParams,
): (user: ScimUser, location: string) => object {
  const project = createResourceProjection(parameters, userSchema);
  return (
    {
      id,
      created,
      lastModified,
      userName,
      active,
      externalId,
      displayName,
      name,
      emails,
    },
    location,
  ) => {
    const fields = {
      userName,
      active,
      externalId,
      displayName,
      name,
      emails,
      meta: { resourceType: "User", location, created, lastModified },
    };
    return project(id, fields);
  };
}
