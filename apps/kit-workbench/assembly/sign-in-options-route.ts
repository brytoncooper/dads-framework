import { getRoute, routeGroup } from "@dads-framework/http";
import {
  signInOptions,
  signInOptionsRoute,
} from "../libraries/sign-in-options/index.js";

export function createSignInOptionsRoutes(enterpriseSso: boolean) {
  return routeGroup("Sign-in", [
    getRoute({
      route: signInOptionsRoute,
      summary: "Read the sign-in methods available on this API",
      access: { kind: "public" },
      response: signInOptions,
      handler: () => ({ enterpriseSso }),
    }),
  ]);
}
