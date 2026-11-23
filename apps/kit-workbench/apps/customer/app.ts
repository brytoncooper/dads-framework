import { composeApi } from "@dads-framework/core/plugin";

import { starterAccess } from "../../assembly/model.js";
import { capabilityServices, type ServiceProvider } from "../../assembly/services.js";
import { notesAttachmentWorker, notesPlugin } from "../../domains/notes/index.js";
import { tenantPermissionsPlugin, tenantsPlugin } from "../../domains/tenants/index.js";
// dad:add imports

export function customerApp(provider: ServiceProvider) {
  return composeApi("customer", {
    services: [provider, ...capabilityServices, starterAccess],
    routes: [
      tenantsPlugin,
      tenantPermissionsPlugin,
      notesPlugin,
      // dad:add domains
    ],
    jobs: [notesAttachmentWorker],
  });
}
