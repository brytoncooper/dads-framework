import {
  entityKindOf,
  visibleRecordException,
  type AccessModel,
} from "@dads-framework/access";

import { HttpWiringError } from "../http-errors.js";
import type { HttpRoute } from "../route/route-group.js";

/**
 * A `requiresVisible` route asks SpiceDB for every id the caller may see and
 * hands them to the query as `WHERE id = ANY(...)`. That is bounded for a
 * `scope` or `catalog`, and unbounded for a `record`, whose lists grow with
 * the business until the page is slow and then fails. So a visibility access
 * on a record refuses to register, and the API refuses to boot, unless the
 * API's boot check registered a dated exception for it.
 *
 * An entity with no declared kind is let through here: the kit serves more
 * than one product, and the product's boot check is what refuses an
 * undeclared entity.
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
  if (entityKindOf(model, access.resourceType) !== "record") return;
  if (visibleRecordException(model, access.resourceType) !== undefined) return;
  throw new HttpWiringError(
    `${route.method} ${route.path} lists ${access.resourceType}, a record, with requiresVisible; ` +
      `a record list must use requiresScoped and declare scope bindings ` +
      `(docs/architecture/authorization.md, "To move a record list onto a scope plan")`,
  );
}
