import { compileAccess } from "@dads-framework/access";
import { anonymousActor } from "@dads-framework/audit-actor";
import { sql } from "drizzle-orm";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { createHealthRoutes } from "@dads-framework/http/health";
import { mountFetchHandler } from "@dads-framework/http/protocol-mounts";
import { IDENTITY_PATH } from "@dads-framework/identity-better-auth";
import type { TelemetryRuntime } from "@dads-framework/telemetry";

import { scimBindingRoutes } from "../domains/tenants/index.js";
import { tenantAccess } from "../libraries/app-runtime/index.js";
import { configureFeaturePreviews } from "./feature-previews.js";
import { apiEntrypoints, type ApiName } from "./api-entrypoints.js";
import { sessionSubjects } from "./session-subjects.js";
import { createSignInOptionsRoutes } from "./sign-in-options-route.js";
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
    return openServices(scope, config, model, composed.flags, name === "staff");
  });
  const composed = apiEntrypoints[name](provider);
  const model = compileAccess(composed.access, {
    allowLookupResourcesOn: [tenantAccess.tenant],
  });
  const running = await composed.start();
  try {
    const {
      authorization,
      identity,
      enterpriseIdentity,
      scimHandler,
      staffImpersonation,
      tenants,
      invitationOrigin,
      db,
      flags,
      local,
      mailJobs,
    } = running.read(provider);
    const featureState =
      name === "customer" && config.featurePreview !== undefined
        ? configureFeaturePreviews({
            configuration: config.featurePreview,
            definitions: composed.flags,
            flags,
            authorization,
          })
        : undefined;
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
    const http = await openHttp(config.baseUrl, local, telemetry);
    http.addHook("onClose", () => running.stop());
    try {
      void http.register(mountFetchHandler({ handler: identity.handle }), {
        prefix: IDENTITY_PATH,
      });
      if (name === "customer" && scimHandler !== undefined) {
        void http.register(
          mountFetchHandler(
            { handler: scimHandler },
            {
              methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            },
          ),
          { prefix: "/scim/v2" },
        );
      }
      if (name === "staff" && staffImpersonation !== undefined) {
        void http.register(
          mountFetchHandler(
            { handler: staffImpersonation },
            {
              methods: ["POST"],
              servePrefixRoot: true,
              bodyLimitBytes: 1024,
            },
          ),
          { prefix: "/api/staff/impersonation" },
        );
      }
      void http.register(
        (api, _options, done) => {
          registerRoutes(api, {
            routes: [
              ...running.routes,
              ...infrastructure,
              ...(name === "customer" && scimHandler !== undefined
                ? scimBindingRoutes(
                    tenants,
                    invitationOrigin,
                    config.enterprise?.scim?.map(({ tenantId }) => tenantId) ??
                      [],
                  )
                : []),
              ...createSignInOptionsRoutes(enterpriseIdentity !== undefined),
            ],
            accessModel: model,
            subjects: sessionSubjects(identity, enterpriseIdentity),
            authorization,
            ...(featureState === undefined ? {} : { featureState }),
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

function openHttp(
  baseUrl: string,
  local: Awaited<ReturnType<typeof openServices>>["local"],
  telemetry?: TelemetryRuntime,
) {
  return createHttpApp({
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    trustedOrigins: [baseUrl],
    diagnostics: local.diagnostics,
    requestLog: () => local.requestLog,
    ...(telemetry === undefined
      ? {}
      : {
          currentTraceId: telemetry.currentTraceId,
          requestTrace: telemetry.annotateRequest,
        }),
  });
}
