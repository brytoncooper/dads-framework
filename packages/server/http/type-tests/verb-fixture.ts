import { z } from "zod";
import type { SubjectRef } from "@dads-framework/access/runtime";
import type {
  RouteDefinition,
  RouteLogger,
} from "../src/lib/route/route-definition.js";

export const thingSchema = z.object({ id: z.string(), name: z.string() });

const noopLog: RouteLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const subject: SubjectRef = { type: "user", id: "u1" };

export const rawInput = (
  overrides: Partial<Parameters<RouteDefinition["execute"]>[0]>,
) => ({
  params: undefined,
  query: undefined,
  body: undefined,
  subject,
  requestId: "req-1",
  locale: "en" as const,
  log: noopLog,
  ...overrides,
});
