import type { StarterProjectFile } from "./render-starter-project.js";

/** Assembly entrypoint, service composition, and session-subject files for the minimal app. */
export function renderMinimalAssemblyFiles(): readonly StarterProjectFile[] {
  return [
    mainAssemblyFile(),
    servicesAssemblyFile(),
    sessionSubjectsFile(),
    startAppAssemblyFile(),
  ];
}

function mainAssemblyFile(): StarterProjectFile {
  return {
    path: "assembly/main.ts",
    content: `import { startTelemetry } from "@dads-framework/telemetry";
import { readEnvironment } from "./config.js";
import { developmentMail } from "./dev-mail.js";

const environment = readEnvironment(process.env);
const logMail = environment.DADS_DEV_LOG_MAIL === "1";
if (
  logMail &&
  (environment.NODE_ENV === "production" || environment.HOST !== "127.0.0.1")
) {
  throw new Error(
    "Local mail logging requires a development server on 127.0.0.1.",
  );
}

const telemetry = await startTelemetry({
  serviceName: \`dads-\${environment.DADS_API}\`,
});
const { startApp } = await import("./start-app.js");
try {
  const app = await startApp(
    environment.DADS_API,
    {
      databaseUrl: environment.DATABASE_URL,
      baseUrl: environment.baseUrl,
      secret: environment.DADS_IDENTITY_SECRET,
      preparePermissionChecks:
        environment.DADS_PREPARE_PERMISSION_CHECKS === "1",
      fileStorageDirectory: environment.DADS_FILE_STORAGE_DIR,
      ...(logMail || environment.NODE_ENV === "production"
        ? { enqueueEmail: developmentMail(logMail) }
        : { mailSpoolDirectory: environment.DADS_MAIL_SPOOL_DIR }),
    },
    telemetry,
  );
  try {
    await app.listen({ host: environment.HOST, port: environment.PORT });
  } catch (fault) {
    await app.close();
    throw fault;
  }
  const close = (): void => {
    void app
      .close()
      .finally(() => telemetry?.shutdown())
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (fault) {
  await telemetry?.shutdown();
  throw fault;
}
`,
  };
}

function servicesAssemblyFile(): StarterProjectFile {
  return {
    path: "assembly/services.ts",
    content: `import type { AccessModel } from "@dads-framework/access";
import { currentAuditActor } from "@dads-framework/audit-actor";
import {
  GetEffectiveFeatureState,
  type FeatureFlagDefinition,
} from "@dads-framework/feature-flags";
import { readFeatureFlagPreview } from "@dads-framework/feature-flags/http";
import { DrizzleFeatureFlagStore } from "@dads-framework/feature-flags/postgres";
import { createBetterAuthIdentity } from "@dads-framework/identity-better-auth";
import { providePlugin, type PluginScope } from "@dads-framework/plugin";
import { createPostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  TransactionalAccessChanges,
} from "@dads-framework/postgres-access";
import { Tenants, type TenantsOptions } from "@dads-framework/tenants";

import {
  starterServices,
  tenantAccess,
  type EnqueueStarterEmail,
  type StarterServices,
} from "../libraries/app-runtime/index.js";

import { createLocalMail, openLocalServices } from "./local-services.js";
import { createProtectedWrite } from "./protected-write.js";

type HostServices = StarterServices & {
  readonly authorization: PostgresAuthorization;
  readonly local: ReturnType<typeof openLocalServices>;
  readonly mailJobs: ReturnType<typeof createLocalMail>["jobs"];
};

export function provideServices(
  create: (scope: PluginScope) => Promise<HostServices>,
) {
  return providePlugin("host-services", starterServices, create);
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
): Promise<HostServices> {
  const connection = openDatabase(scope, config.databaseUrl);
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
  const tenantOptions: TenantsOptions = {
    database: connection.drizzle,
    access: tenantAccess,
    authorizationAt: (tx) => authorization.inDrizzleTransaction(tx),
    changes: new TransactionalAccessChanges(authorization, connection.drizzle),
  };
  const tenants = new Tenants(tenantOptions);
  const identity = createBetterAuthIdentity({
    database: connection,
    baseUrl: config.baseUrl,
    secret: config.secret,
    enqueueEmail,
    canInvite: () => Promise.resolve(false),
  });
  return Promise.resolve({
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
      readFeatureFlagPreview,
    ),
  });
}

function openDatabase(scope: PluginScope, connectionString: string) {
  const connection = createPostgresConnection(
    { schema: {}, connectionString, auditActorSource: currentAuditActor },
    {
      error: (_fault, message) => {
        process.stderr.write(
          \`\${message ?? "Could not close the database connection."}\\n\`,
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
`,
  };
}

function sessionSubjectsFile(): StarterProjectFile {
  return {
    path: "assembly/session-subjects.ts",
    content: `import type { SubjectResolver } from "@dads-framework/http";
import type { Identity } from "@dads-framework/identity";
import { tenantIdSchema } from "@dads-framework/tenants";

import { account } from "../libraries/app-runtime/index.js";

export function sessionSubjects(identity: Identity): SubjectResolver {
  return {
    async resolve({ headers, params }) {
      const normalized = new Headers();
      for (const [name, header] of Object.entries(headers)) {
        if (typeof header === "string") normalized.set(name, header);
      }
      const tenantId = tenantFromParams(params);
      if (tenantId === null) return null;
      const session = await identity.readSession(normalized);
      return session === null
        ? null
        : { type: account.wireName, id: session.account.id };
    },
  };
}

/** Undefined is unscoped. Null means the matched tenant parameter is invalid. */
export function tenantFromParams(params: unknown): string | null | undefined {
  if (typeof params !== "object" || params === null || !("tenantId" in params))
    return undefined;
  const tenant = tenantIdSchema.safeParse(params.tenantId);
  return tenant.success ? tenant.data.toLowerCase() : null;
}
`,
  };
}

function startAppAssemblyFile(): StarterProjectFile {
  return {
    path: "assembly/start-app.ts",
    content: `import { accessModel } from "@dads-framework/access";
import { anonymousActor } from "@dads-framework/audit-actor";
import { sql } from "drizzle-orm";
import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { createHealthRoutes } from "@dads-framework/http/health";
import { mountFetchHandler } from "@dads-framework/http/protocol-mounts";
import { IDENTITY_PATH } from "@dads-framework/identity-better-auth";
import type { TelemetryRuntime } from "@dads-framework/telemetry";

import { apiEntrypoints, type ApiName } from "./api-entrypoints.js";
import { sessionSubjects } from "./session-subjects.js";
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
  const provider = provideServices((scope) =>
    openServices(scope, config, model, composed.flags),
  );
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
        await db.execute(sql\`select 1\`);
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
`,
  };
}
