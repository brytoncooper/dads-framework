import { through } from "../combinators.js";
import { access } from "../model.js";
import type { AccessDefinition } from "../model.js";
import type { ThroughTerm } from "../refs.js";
import { beta } from "./cycle-beta.access.js";
import { Alpha, Beta } from "./cycle-entities.js";

type AlphaRoles = { readonly peer: typeof Beta };
type AlphaPermissions = { readonly view: readonly ThroughTerm[] };

export const alpha: AccessDefinition<AlphaRoles, AlphaPermissions> = access(
  Alpha,
  {
    roles: {
      peer: Beta,
    },
    permissions: (roles) => ({
      view: [through(roles.peer, beta.permissions.view)],
    }),
  },
);
