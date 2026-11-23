import { composeApi } from "@dads-framework/core/plugin";

import { starterAccess } from "../../assembly/model.js";
import type { ServiceProvider } from "../../assembly/services.js";
import {
  tenantAuditExportPlugin,
  tenantsPlugin,
} from "../../domains/tenants/index.js";
// dad:add imports

export function staffApp(provider: ServiceProvider) {
  return composeApi("staff", {
    services: [provider, starterAccess],
    routes: [
      tenantsPlugin,
      tenantAuditExportPlugin,
      // dad:add domains
    ],
    jobs: [],
  });
}
