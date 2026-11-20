import { accessModel } from "@dads-framework/access";
import { anonymousActor } from "@dads-framework/audit-actor";
import { createHealthRoutes } from "@dads-framework/health";
import { sql } from "drizzle-orm";
import {
  createHttpApp,
  registerRoutes,
  type SubjectResolver,
} from "@dads-framework/http";
import { mountFetchHandler } from "@dads-framework/http/protocol-mounts";
import type { Identity } from "@dads-framework/identity";
import { IDENTITY_PATH } from "@dads-framework/identity-better-auth";
import type { TelemetryRuntime } from "@dads-framework/telemetry";

import { apiEntrypoints, type ApiName } from "./api-entrypoints.js";
import { accountEntity } from "../libraries/app-runtime/index.js";
import {
  openServices,
  provideServices,
  type ServiceConfiguration,
} from "./services.js";

export async function startApp(
  name: ApiName,
  config: ServiceConfiguration,
  telemetry?: TelemetryRuntime,
) {
  const provider = provideServices((scope) => {
    return openServices(scope, config, model, composed.flags);
  });
  const composed = apiEntrypoints[name](provider);
  const model = accessModel(composed.access);
  const running = await composed.start();
  try {
    const { authorization, identity, db, local, mailJobs } =
      running.read(provider);
    await local.prepareFiles();
    local.queue.register([...mailJobs, ...running.jobs]);
    await local.queue.start();
    const infrastructure = createHealthRoutes({
      pingDatabase: async () => {
        await db.execute(sql`select 1`);
      },
      pingCriticalServices: async () => {
        await Promise.all([local.queue.inspect(), local.checkFiles()]);
      },
    });
    const http = await createHttpApp({
      nodeEnv: process.env["NODE_ENV"] ?? "development",
      trustedOrigins: [config.baseUrl],
      diagnostics: local.diagnostics,
      requestLog: () => local.requestLog,
      ...(telemetry === undefined
        ? {}
        : {
            currentTraceId: telemetry.currentTraceId,
            requestTrace: telemetry.annotateRequest,
          }),
    });
    http.addHook("onClose", () => running.stop());
    try {
      void http.register(mountFetchHandler({ handler: identity.handle }), {
        prefix: IDENTITY_PATH,
      });
      void http.register(
        (api, _options, done) => {
          registerRoutes(api, {
            routes: [...running.routes, ...infrastructure],
            accessModel: model,
            subjects: sessionSubjects(identity),
            authorization,
            auditActorForSubject: ({ subject, requestId }) =>
              subject === null
                ? anonymousActor(requestId)
                : { kind: "account", id: subject.id, requestId },
          });
          done();
        },
        { prefix: "/api" },
      );
      await http.ready();
      return http;
    } catch (fault) {
      await http.close();
      throw fault;
    }
  } catch (fault) {
    await running.stop();
    throw fault;
  }
}

function sessionSubjects(identity: Identity): SubjectResolver {
  return {
    async resolve({ headers }) {
      const normalized = new Headers();
      for (const [name, header] of Object.entries(headers)) {
        if (typeof header === "string") normalized.set(name, header);
      }
      const session = await identity.readSession(normalized);
      return session === null
        ? null
        : { type: accountEntity.wireName, id: session.account.id };
    },
  };
}
