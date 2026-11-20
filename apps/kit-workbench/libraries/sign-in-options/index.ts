import { defineRoute } from "@dads-framework/contract";
import { z } from "zod";

export const signInOptionsRoute = defineRoute(
  "GET",
  "/sign-in-options",
  () => "/sign-in-options",
);

export const signInOptions = z.strictObject({ enterpriseSso: z.boolean() });
