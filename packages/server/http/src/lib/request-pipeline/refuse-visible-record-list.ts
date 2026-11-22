import type { AccessModel } from "@dads-framework/access";
import { isLookupResourcesAllowed } from "@dads-framework/access/scopes";

import { HttpWiringError } from "../http-errors.js";
import type { HttpRoute } from "../route/route-group.js";

/**
 * A `requiresVisible` route asks SpiceDB for every id the caller may see and
 * hands them to the query as `WHERE id = ANY(...)`. That is unbounded for
 * records, whose lists grow with the business until the page is slow and then
 * fails. So a visibility route refuses to register (fail-closed) unless the
 * compiled access model explicitly names the resource type in
 * `allowLookupResourcesOn` and does not bind it in `scopeBindings`.
 */
export function refuseVisibleRecordList(
  route: HttpRoute,
  model: AccessModel | undefined,
): void {
  const access = route.access;
  if (access.kind !== "visibility") return;
  if (model === undefined) {
    throw new HttpWiringError(
      `${route.method} ${route.path} uses requiresVisible without an access model`,
    );
  }
  if (
    !model.definitions.some(
      ({ entity }) => entity.wireName === access.resourceType,
    )
  ) {
    throw new HttpWiringError(
      `${route.method} ${route.path} uses requiresVisible for ${access.resourceType}, which is missing from the access model`,
    );
  }
  if (isLookupResourcesAllowed(model, access.resourceType)) return;
  throw new HttpWiringError(
    `${route.method} ${route.path} lists ${access.resourceType} with requiresVisible, ` +
      `which is refused unless ${access.resourceType} is in allowLookupResourcesOn (and not bound in scopeBindings); ` +
      `a record list must use requiresScoped and declare scope bindings ` +
      `(docs/architecture/authorization.md, "To move a record list onto a scope plan")`,
  );
}
