import { definePlugin } from "@dads-framework/core/plugin";
import { accountAccess, tenantAccess } from "../libraries/app-runtime/index.js";

export const starterAccess = definePlugin({
  name: "starter-access",
  contributes: { access: [accountAccess, tenantAccess.tenant] },
});
