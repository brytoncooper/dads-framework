import { renderMinimalAssemblyFiles } from "./minimal-project-assembly.js";
import type { StarterProjectFile } from "./render-starter-project.js";

/** Core server, domain, and bootstrap migration files for the minimal app. */
export function renderMinimalServerFiles(): readonly StarterProjectFile[] {
  return [
    customerEntrypointFile(),
    staffEntrypointFile(),
    ...renderMinimalAssemblyFiles(),
    tenantsIndexFile(),
    tenantsPluginFile(),
    starterMigrationFile(),
  ];
}

function customerEntrypointFile(): StarterProjectFile {
  return {
    path: "apps/customer/app.ts",
    content: `import { composeApi } from "@dads-framework/core/plugin";

import { starterAccess } from "../../assembly/model.js";
import type { ServiceProvider } from "../../assembly/services.js";
import { tenantsPlugin } from "../../domains/tenants/index.js";
// dad:add imports

export function customerApp(provider: ServiceProvider) {
  return composeApi("customer", {
    services: [provider, starterAccess],
    routes: [
      tenantsPlugin,
      // dad:add domains
    ],
    jobs: [],
  });
}
`,
  };
}

function staffEntrypointFile(): StarterProjectFile {
  return {
    path: "apps/staff/app.ts",
    content: `import { composeApi } from "@dads-framework/core/plugin";

import { starterAccess } from "../../assembly/model.js";
import type { ServiceProvider } from "../../assembly/services.js";
import { tenantsPlugin } from "../../domains/tenants/index.js";
// dad:add imports

export function staffApp(provider: ServiceProvider) {
  return composeApi("staff", {
    services: [provider, starterAccess],
    routes: [
      tenantsPlugin,
      // dad:add domains
    ],
    jobs: [],
  });
}
`,
  };
}

function tenantsIndexFile(): StarterProjectFile {
  return {
    path: "domains/tenants/index.ts",
    content: `export { tenantsPlugin } from "./server/plugin.js";
`,
  };
}

function tenantsPluginFile(): StarterProjectFile {
  return {
    path: "domains/tenants/server/plugin.ts",
    content: `import { definePlugin } from "@dads-framework/core/plugin";
import { starterServices } from "../../../libraries/app-runtime/index.js";
import { tenantInvitationRoutes } from "./invitation-routes.js";
import { tenantRoutes } from "./routes.js";

export const tenantsPlugin = definePlugin({
  name: "tenant-routes",
  requires: [starterServices],
  setup: ({ use }) => {
    const services = use(starterServices);
    return {
      routes: [
        ...tenantRoutes(services.tenants),
        ...tenantInvitationRoutes(services),
      ],
    };
  },
});
`,
  };
}

function starterMigrationFile(): StarterProjectFile {
  return {
    path: "migrations/20261120080000_starter.migration.ts",
    content: `import {
  configureAuditTriggers,
  installAuditSchemaV1,
} from "@dads-framework/audit";
import { installFeatureFlagSchemaV1 } from "@dads-framework/feature-flags-postgres";
import { installIdentitySchemaV2 } from "@dads-framework/identity/better-auth";
import { relationshipSchemaMigration } from "@dads-framework/postgres-access";
import {
  installTenantSchemaV1,
  tenantAuditConfiguration,
} from "@dads-framework/identity/tenants";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(relationshipSchemaMigration.sql);
  installIdentitySchemaV2(pgm);
  installTenantSchemaV1(pgm);
  installFeatureFlagSchemaV1(pgm);
  installAuditSchemaV1(pgm);
  configureAuditTriggers(pgm, tenantAuditConfiguration);
}

/** Bootstrap migrations only move forward. */
export const down = false;
`,
  };
}
