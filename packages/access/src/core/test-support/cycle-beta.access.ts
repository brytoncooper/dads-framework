import { through } from "../combinators.js";
import { access } from "../model.js";
import type { AccessDefinition } from "../model.js";
import type { ThroughTerm } from "../refs.js";
import { alpha } from "./cycle-alpha.access.js";
import { Alpha, Beta } from "./cycle-entities.js";

type BetaRoles = { readonly peer: typeof Alpha };
type BetaPermissions = { readonly view: readonly ThroughTerm[] };

export const beta: AccessDefinition<BetaRoles, BetaPermissions> = access(Beta, {
  roles: {
    peer: Alpha,
  },
  permissions: (roles) => ({
    view: [through(roles.peer, alpha.permissions.view)],
  }),
});
