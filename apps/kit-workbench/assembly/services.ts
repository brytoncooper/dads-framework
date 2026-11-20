import type { AccessModel } from "@dads-framework/access";
import { currentAuditActor } from "@dads-framework/audit-actor";
import {
  GetEffectiveFeatureState,
  type FeatureFlagDefinition,
} from "@dads-framework/feature-flags";
import { DrizzleFeatureFlagStore } from "@dads-framework/feature-flags-postgres";
import { createBetterAuthIdentity } from "@dads-framework/identity-better-auth";
import { definePlugin, type PluginScope } from "@dads-framework/plugin";
import { createPostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import { Tenants } from "@dads-framework/tenants";

import {
  starterServices,
  tenantAccess,
  type StarterServices,
  type EnqueueStarterEmail,
} from "../libraries/app-runtime/index.js";

import { createLocalMail, openLocalServices } from "./local-services.js";
import { createProtectedWrite } from "./protected-write.js";

type HostServices = StarterServices & {
  readonly authorization: PostgresAuthorization;
  readonly local: ReturnType<typeof openLocalServices>;
  readonly mailJobs: ReturnType<typeof createLocalMail>["jobs"];
};

export function provideServices(create: (scope: PluginScope) => HostServices) {
  return definePlugin<
    "host-services",
    [],
    HostServices,
    never,
    never,
    never,
    "starter-services"
  >({
    name: "host-services",
    implements: starterServices,
    setup: ({ scope }) => ({ provides: create(scope) }),
  });
}

export type ServiceProvider = ReturnType<typeof provideServices>;

export type ServiceConfiguration = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly secret: string;
  readonly preparePermissionChecks?: boolean;
  readonly enqueueEmail?: EnqueueStarterEmail;
  readonly fileStorageDirectory?: string;
  readonly mailSpoolDirectory?: string;
};

export function openServices(
  scope: PluginScope,
  config: ServiceConfiguration,
  model: AccessModel,
  definitions: readonly FeatureFlagDefinition[],
) {
  const connection = createPostgresConnection(
    {
      schema: {},
      connectionString: config.databaseUrl,
      auditActorSource: currentAuditActor,
    },
    {
      error: (_fault, message) => {
        process.stderr.write(
          `${message ?? "Could not close the database connection."}\n`,
        );
      },
    },
  );
  scope.onDispose(connection.close);
  const local = openLocalServices(scope, config, connection.drizzle);
  const mail =
    config.mailSpoolDirectory === undefined
      ? undefined
      : createLocalMail(
          connection.drizzle,
          local.queue,
          config.mailSpoolDirectory,
        );
  const enqueueEmail = config.enqueueEmail ?? mail?.enqueueEmail;
  if (enqueueEmail === undefined)
    throw new Error("Configure an email sender before starting the app.");
  const authorization = new PostgresAuthorization({
    model,
    namespace: "starter",
    executor: config.preparePermissionChecks
      ? preparePostgresChecks(connection.pool)
      : connection.pool,
  });
  const tenants = new Tenants({
    database: connection.drizzle,
    access: tenantAccess,
    authorizationAt: (tx) => authorization.inDrizzleTransaction(tx),
    changes: new TransactionalAccessChanges(authorization, connection.drizzle),
  });
  const identity = createBetterAuthIdentity({
    database: connection,
    baseUrl: config.baseUrl,
    secret: config.secret,
    enqueueEmail,
    canInvite: () => Promise.resolve(false),
  });
  return {
    db: connection.drizzle,
    local,
    mailJobs: mail?.jobs ?? [],
    files: local.storage,
    jobs: local.queue,
    writeWithPermission: createProtectedWrite(
      connection.drizzle,
      authorization,
    ),
    tenants,
    identity,
    invitationOrigin: new URL(config.baseUrl).origin,
    enqueueTenantInvitation: tenantInvitationMailer(
      config.baseUrl,
      enqueueEmail,
    ),
    authorization,
    flags: new GetEffectiveFeatureState(
      definitions,
      new DrizzleFeatureFlagStore(connection.drizzle),
    ),
  };
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
