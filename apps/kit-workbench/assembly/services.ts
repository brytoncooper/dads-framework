import type { AccessModel } from "@dads-framework/access";
import { DrizzleAuditLogReader } from "@dads-framework/audit";
import { currentAuditActor } from "@dads-framework/core/audit-actor";
import { GetEffectiveFeatureState, type FeatureFlagDefinition } from "@dads-framework/feature-flags";
import { readFeatureFlagPreview } from "@dads-framework/feature-flags/http";
import { DrizzleFeatureFlagStore } from "@dads-framework/feature-flags/postgres";
import { definePlugin, providePlugin, type PluginScope, type Service } from "@dads-framework/core/plugin";
import { createPostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import { Tenants, type TenantsOptions } from "@dads-framework/identity/tenants";

import {
  databaseService,
  featureFlagsService,
  jobQueueService,
  objectStorageService,
  protectedWriteService,
  starterServices,
  tenantAccess,
  type StarterServices,
  type EnqueueStarterEmail,
} from "../libraries/app-runtime/index.js";

import { createLocalMail, openLocalServices } from "./local-services.js";
import { createProtectedWrite } from "./protected-write.js";
import { openIdentityServices } from "./identity-services.js";
import type { FeaturePreviewConfiguration } from "./feature-previews.js";
import type { EnterpriseConfiguration } from "./enterprise-config.js";
import { openStaffImpersonationServices, type StaffImpersonationServices } from "./staff-impersonation-services.js";

export type HostServices = StarterServices &
  Awaited<ReturnType<typeof openIdentityServices>> &
  StaffImpersonationServices & {
    readonly authorization: PostgresAuthorization;
    readonly local: ReturnType<typeof openLocalServices>;
    readonly mailJobs: ReturnType<typeof createLocalMail>["jobs"];
  };

export function provideServices(create: (scope: PluginScope) => Promise<HostServices>) {
  return providePlugin("host-services", starterServices, create);
}

function projectCapability<const Name extends string, ServiceName extends string, Value>(
  name: Name,
  service: Service<ServiceName, Value>,
  select: (services: StarterServices) => Value,
) {
  return definePlugin<Name, readonly [typeof starterServices], Value, never, never, never, ServiceName>({
    name,
    requires: [starterServices],
    implements: service,
    setup: ({ use }) => ({ provides: select(use(starterServices)) }),
  });
}

export const capabilityServices = [
  projectCapability("database-capability", databaseService, ({ db }) => db),
  projectCapability("feature-flags-capability", featureFlagsService, ({ flags }) => flags),
  projectCapability("object-storage-capability", objectStorageService, ({ files }) => files),
  projectCapability("job-queue-capability", jobQueueService, ({ jobs }) => jobs),
  projectCapability(
    "protected-write-capability",
    protectedWriteService,
    ({ writeWithPermission }) => writeWithPermission,
  ),
];

export type ServiceProvider = ReturnType<typeof provideServices>;

export type ServiceConfiguration = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly secret: string;
  readonly enterprise?: EnterpriseConfiguration;
  readonly featurePreview?: FeaturePreviewConfiguration;
  readonly preparePermissionChecks?: boolean;
  readonly enqueueEmail?: EnqueueStarterEmail;
  readonly fileStorageDirectory?: string;
  readonly mailSpoolDirectory?: string;
};

export async function openServices(
  scope: PluginScope,
  config: ServiceConfiguration,
  model: AccessModel,
  definitions: readonly FeatureFlagDefinition[],
  enableStaffImpersonation = false,
) {
  const connection = openDatabase(scope, config.databaseUrl);
  const local = openLocalServices(scope, config, connection.drizzle);
  const mail =
    config.mailSpoolDirectory === undefined
      ? undefined
      : createLocalMail(connection.drizzle, local.queue, config.mailSpoolDirectory);
  const enqueueEmail = config.enqueueEmail ?? mail?.enqueueEmail;
  if (enqueueEmail === undefined) throw new Error("Configure an email sender before starting the app.");
  const authorization = new PostgresAuthorization({
    model,
    namespace: "starter",
    executor: config.preparePermissionChecks ? preparePostgresChecks(connection.pool) : connection.pool,
  });
  const tenantOptions: TenantsOptions = {
    database: connection.drizzle,
    access: tenantAccess,
    authorizationAt: (tx) => authorization.inDrizzleTransaction(tx),
    changes: new TransactionalAccessChanges(authorization, connection.drizzle),
  };
  const tenants = new Tenants(tenantOptions);
  const identity = await openIdentityServices(
    {
      database: connection,
      baseUrl: config.baseUrl,
      secret: config.secret,
      enqueueEmail,
      canInvite: () => Promise.resolve(false),
    },
    config.enterprise,
    tenantOptions,
  );
  return {
    db: connection.drizzle,
    auditLogReader: new DrizzleAuditLogReader(connection.drizzle),
    local,
    mailJobs: mail?.jobs ?? [],
    files: local.storage,
    jobs: local.queue,
    writeWithPermission: createProtectedWrite(connection.drizzle, authorization),
    tenants,
    ...identity,
    ...(enableStaffImpersonation
      ? openStaffImpersonationServices(connection.pool, config, identity, tenants)
      : { staffImpersonation: undefined }),
    invitationOrigin: new URL(config.baseUrl).origin,
    enqueueTenantInvitation: tenantInvitationMailer(config.baseUrl, enqueueEmail),
    authorization,
    flags: new GetEffectiveFeatureState(
      definitions,
      new DrizzleFeatureFlagStore(connection.drizzle),
      readFeatureFlagPreview,
    ),
  };
}

function openDatabase(scope: PluginScope, connectionString: string) {
  const connection = createPostgresConnection(
    { schema: {}, connectionString, auditActorSource: currentAuditActor },
    {
      error: (_fault, message) => {
        process.stderr.write(
          `${message ?? "Could not close the database connection."}
`,
        );
      },
    },
  );
  scope.onDispose(connection.close);
  return connection;
}

function tenantInvitationMailer(
  baseUrl: string,
  enqueueEmail: EnqueueStarterEmail,
): StarterServices["enqueueTenantInvitation"] {
  return (email, token) => {
    const url = new URL("/accept-tenant-invitation", baseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    return enqueueEmail({
      kind: "tenant-invitation",
      to: email,
      url: url.href,
    });
  };
}
