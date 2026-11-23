/**
 * Which modules decide what crosses the wire, read from the module itself.
 *
 * A module declares routes when it calls a route builder — `getRoute`,
 * `listRoute`, `postRoute`, `patchRoute`, `putRoute`, `deleteRoute`,
 * `postNoContentRoute` — the vocabulary both HTTP kits share. A module in an
 * `http/` directory below a package's `src/` is response code by where it was
 * put, which is how a package keeps its handlers and mappers beside the routes
 * that send them. A package that is itself named `http` is not: its source is
 * the transport, not somebody's responses.
 *
 * The folder rule is the weaker of the two and the only one a signal can use
 * for a handler that lives apart from its route card; the call rule is the one
 * that cannot be fooled by a folder name.
 */

import { ts, visitNodes, type DoctorModule } from "./typescript-program.js";

const ROUTE_BUILDER = /^(?:get|list|post|patch|put|delete|postNoContent)Route$/;
const HTTP_DIRECTORY = /\/src\/(?:[^/]+\/)*http\//;

/** True for a call to a route builder. */
export function isRouteBuilderCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ROUTE_BUILDER.test(node.expression.text);
}

/** True when a module calls a route builder anywhere in it. */
export function declaresRoutes(module: DoctorModule): boolean {
  if (!module.source.text.includes("Route(")) return false;
  let found = false;
  visitNodes(module.source, (node) => {
    if (isRouteBuilderCall(node)) found = true;
  });
  return found;
}

/** True for a module that decides what a response carries. */
export function isResponseCode(module: DoctorModule): boolean {
  return HTTP_DIRECTORY.test(module.path) || declaresRoutes(module);
}
