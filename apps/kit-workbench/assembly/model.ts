import type { DslNode } from "@dads-framework/access";
import { definePlugin } from "@dads-framework/core/plugin";
import { accountAccess, tenantAccess } from "../libraries/app-runtime/index.js";

const starterAccessNodes: readonly DslNode[] = [accountAccess, tenantAccess.tenant];

export const starterAccess = definePlugin({
  name: "starter-access",
  contributes: { access: starterAccessNodes },
});
