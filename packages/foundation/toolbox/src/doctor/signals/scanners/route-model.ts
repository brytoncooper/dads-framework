import { readRouteSource, type SourceRoute } from "../../../route-inspection/read-route-source.js";
import type { DoctorContext } from "../../doctor-context.js";
import { readPackageGraph, type GraphPackage } from "./package-graph.js";

export type RouteOperation = SourceRoute & {
  readonly packageName: string;
  readonly path: string;
};

type RouteModel = {
  readonly operations: readonly RouteOperation[];
  readonly packagesWithRoutes: readonly GraphPackage[];
};

const models = new WeakMap<DoctorContext, RouteModel>();

/** Models only declared route source and never starts an application. */
export function readRouteModel(context: DoctorContext): RouteModel {
  const known = models.get(context);
  if (known) return known;

  const operations: RouteOperation[] = [];
  const packagesWithRoutes: GraphPackage[] = [];
  for (const declared of readPackageGraph(context).packages) {
    const routes = readPackageRoutes(context, declared);
    if (routes.length > 0) packagesWithRoutes.push(declared);
    operations.push(...routes);
  }
  const model = { operations, packagesWithRoutes };
  models.set(context, model);
  return model;
}

function readPackageRoutes(context: DoctorContext, owner: GraphPackage): readonly RouteOperation[] {
  const readFile = (relativePath: string): string | undefined => {
    if (!context.exists(relativePath)) return undefined;
    try {
      return context.read(relativePath);
    } catch {
      return undefined;
    }
  };
  return owner.sources.flatMap((path) => {
    if (!/\.tsx?$/.test(path)) return [];
    return readRouteSource(context.read(path), path, { readFile }).map((route) => ({
      ...route,
      path,
      packageName: owner.name,
    }));
  });
}

export function isListOperation(operation: RouteOperation): boolean {
  return operation.schemas.item !== undefined;
}

export function operationKey(operation: RouteOperation): string {
  return `${operation.path}:${operation.operation}`;
}

export function operationEvidence(operation: RouteOperation) {
  return {
    path: operation.path,
    line: operation.line,
    name: operation.operation,
  };
}
