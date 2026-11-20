import { definePlugin } from "@dads-framework/plugin";
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
