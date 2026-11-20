import { composeApi } from "@dads-framework/plugin";

import { starterAccess } from "../../assembly/model.js";
import type { ServiceProvider } from "../../assembly/services.js";
import {
  notesAttachmentWorker,
  notesPlugin,
} from "../../domains/notes/index.js";
import { tenantsPlugin } from "../../domains/tenants/index.js";
// dad:add imports

export function customerApp(provider: ServiceProvider) {
  return composeApi("customer", {
    services: [provider, starterAccess],
    routes: [
      tenantsPlugin,
      notesPlugin,
      // dad:add domains
    ],
    jobs: [notesAttachmentWorker],
  });
}
