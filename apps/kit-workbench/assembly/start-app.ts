import { compileAccess } from "@dads-framework/access";
import { anonymousActor } from "@dads-framework/core/audit-actor";
import { startHttpHost, type HttpProtocolMount } from "@dads-framework/http";
import type { TelemetryRuntime } from "@dads-framework/http/telemetry";
import { IDENTITY_PATH } from "@dads-framework/identity/better-auth";
import { sql } from "drizzle-orm";

import { scimBindingRoutes } from "../domains/tenants/index.js";
import { tenantAccess } from "../libraries/app-runtime/index.js";
import { apiEntrypoints, type ApiName } from "./api-entrypoints.js";
import { configureFeaturePreviews } from "./feature-previews.js";
import { openServices, provideServices, type HostServices, type ServiceConfiguration } from "./services.js";
import { sessionSubjects } from "./session-subjects.js";
import { createSignInOptionsRoutes } from "./sign-in-options-route.js";

export async function startApp(name: ApiName, config: ServiceConfiguration, telemetry?: TelemetryRuntime) {
  const provider = provideServices((scope) => openServices(scope, config, model, composed.flags, name === "staff"));
  const composed = apiEntrypoints[name](provider);
  const model = compileAccess(composed.access, { allowLookupResourcesOn: [tenantAccess.tenant] });
  const running = await composed.start();
  try {
    const services = running.read(provider);
    const { authorization, identity, enterpriseIdentity, scimHandler, tenants, invitationOrigin, db, flags, local } =
      services;
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
    local.queue.register([...services.mailJobs, ...running.jobs]);
    await local.queue.start();
    const scimRoutes =
      name === "customer" && scimHandler !== undefined
        ? scimBindingRoutes(tenants, invitationOrigin, config.enterprise?.scim?.map(({ tenantId }) => tenantId) ?? [])
        : [];
    return await startHttpHost({
      baseUrl: config.baseUrl,
      diagnostics: local.diagnostics,
      requestLog: () => local.requestLog,
      ...(telemetry === undefined ? {} : { telemetry }),
      mounts: buildProtocolMounts(name, services),
      health: {
        pingDatabase: async () => {
          await db.execute(sql`select 1`);
        },
        pingCriticalServices: async () => {
          await Promise.all([local.queue.inspect(), local.checkFiles()]);
        },
      },
      routes: [...running.routes, ...scimRoutes, ...createSignInOptionsRoutes(enterpriseIdentity !== undefined)],
      accessModel: model,
      subjects: sessionSubjects(identity, enterpriseIdentity),
      authorization,
      ...(featureState === undefined ? {} : { featureState }),
      auditActorForSubject: ({ subject, requestId }) =>
        subject === null ? anonymousActor(requestId) : { kind: "account", id: subject.id, requestId },
      onClose: () => running.stop(),
    });
  } catch (fault) {
    await running.stop();
    throw fault;
  }
}

function buildProtocolMounts(
  name: ApiName,
  services: Pick<HostServices, "identity" | "scimHandler" | "staffImpersonation">,
): readonly HttpProtocolMount[] {
  const mounts: HttpProtocolMount[] = [{ prefix: IDENTITY_PATH, handler: services.identity.handle }];
  if (name === "customer" && services.scimHandler !== undefined) {
    mounts.push({
      prefix: "/scim/v2",
      handler: services.scimHandler,
      options: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    });
  }
  if (name === "staff" && services.staffImpersonation !== undefined) {
    mounts.push({
      prefix: "/api/staff/impersonation",
      handler: services.staffImpersonation,
      options: { methods: ["POST"], servePrefixRoot: true, bodyLimitBytes: 1024 },
    });
  }
  return mounts;
}
