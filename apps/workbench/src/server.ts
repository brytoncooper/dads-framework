import { randomUUID } from "node:crypto";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import {
  workbenchAccessModel,
  workbenchUser,
  type WorkbenchAuthorization,
} from "./access.js";
import { createWorkbench } from "./create-workbench.js";
import { workbenchAuthorizationReadError } from "./operations/workbench-authorization.js";
import { routeOutcome } from "./route-outcome.js";
import { workbenchOpenApi } from "./workbench-openapi.js";
import type { WorkbenchStore } from "./storage/workbench-store.js";

/** Synthetic local identities available from the loopback-only workbench. */
export const demoIdentities = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "outsider", name: "Outsider" },
];

export type WorkbenchServerOptions = {
  readonly store: WorkbenchStore;
  readonly authorization: WorkbenchAuthorization;
  readonly port?: number;
};

/** Starts the real API on loopback. The caller owns storage and authorization. */
export function startWorkbenchServer(options: WorkbenchServerOptions) {
  const workbench = createWorkbench({
    store: options.store,
    authorization: options.authorization,
    clock: () => new Date().toISOString(),
    createId: randomUUID,
  });
  return startComposedWorkbenchServer({
    workbench,
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}

export type ComposedWorkbenchServerOptions = {
  readonly workbench: ReturnType<typeof createWorkbench>;
  readonly port?: number;
};

export async function startComposedWorkbenchServer(
  options: ComposedWorkbenchServerOptions,
) {
  const { workbench } = options;
  await workbench.operations.synchronize();
  const http = await createHttpApp({
    nodeEnv: "development",
    trustedOrigins: [],
    logger: false,
    bodyLimitBytes: 65_536,
  });
  let origin: URL | undefined;
  const document = workbenchOpenApi(workbench.routes);
  try {
    http.get("/api/openapi.json", () => document);
    http.get("/api/demo/identities", () => ({
      data: demoIdentities,
      meta: { demoOnly: true },
    }));
    registerRoutes(http, {
      routes: workbench.routes,
      accessModel: workbenchAccessModel,
      authorization: {
        check: (query) =>
          routeOutcome(async () => {
            await workbench.operations.synchronize();
            return authenticatedRead(() =>
              workbench.authorization.check(query),
            );
          }),
      },
      lookups: {
        lookupResources: (query) =>
          routeOutcome(async () => {
            await workbench.operations.synchronize();
            return authenticatedRead(() =>
              workbench.authorization.lookupResources(query),
            );
          }),
      },
      subjects: {
        resolve: ({ headers }) => {
          if (origin === undefined || headers["host"] !== origin.host)
            return Promise.resolve(null);
          if (
            headers["origin"] !== undefined &&
            headers["origin"] !== origin.origin
          )
            return Promise.resolve(null);
          const id = headers["x-workbench-user"];
          return Promise.resolve(
            typeof id === "string" &&
              demoIdentities.some((identity) => identity.id === id)
              ? { type: workbenchUser.wireName, id }
              : null,
          );
        },
      },
    });
    const url = await http.listen({
      host: "127.0.0.1",
      port: options.port ?? 4317,
    });
    origin = new URL(url);
    return { url, stop: () => http.close() };
  } catch (error) {
    await http.close();
    throw error;
  }
}

async function authenticatedRead<Result>(
  read: () => Promise<Result>,
): Promise<Result> {
  try {
    return await read();
  } catch (cause) {
    throw workbenchAuthorizationReadError(cause);
  }
}
