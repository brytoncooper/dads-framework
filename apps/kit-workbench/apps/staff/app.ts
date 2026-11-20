import type { JobDefinition } from "@dads-framework/job-queue-core";
import { composeApi, type Plugin } from "@dads-framework/plugin";

import { starterAccess } from "../../assembly/model.js";
import type { ServiceProvider } from "../../assembly/services.js";
import {
  tenantAuditExportPlugin,
  tenantsPlugin,
} from "../../domains/tenants/index.js";
// dad:add imports

const staffWorkers: readonly Plugin<
  never,
  never,
  never,
  never,
  JobDefinition,
  never,
  never,
  never
>[] = [];

export function staffApp(provider: ServiceProvider) {
  return composeApi("staff", {
    services: [provider, starterAccess],
    routes: [
      tenantsPlugin,
      tenantAuditExportPlugin,
      // dad:add domains
    ],
    jobs: staffWorkers,
  });
}
