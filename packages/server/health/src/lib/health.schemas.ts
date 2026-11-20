import { z } from "zod";

export const healthStatusSchema = z.object({
  status: z.literal("ok").meta({ description: "Process liveness" }),
});

export const readyStatusSchema = z.object({
  status: z.literal("ready").meta({
    description: "Service readiness — critical services reachable",
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type ReadyStatus = z.infer<typeof readyStatusSchema>;
