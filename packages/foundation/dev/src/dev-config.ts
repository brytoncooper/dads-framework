import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const commandSchema = z.tuple([z.string().min(1)], z.string());
const serviceSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  command: commandSchema,
  portOffset: z.number().int().nonnegative(),
  readyPath: z.string().regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/),
  env: z.record(z.string(), z.string()).default({}),
});

export const devConfigSchema = z.strictObject({
  services: z.array(serviceSchema).min(1),
  basePort: z.number().int().min(1024).default(4300),
  portsPerSlot: z.number().int().positive().max(32).default(10),
  maxSlots: z.number().int().positive().max(256).default(32),
  prepare: commandSchema.optional(),
});

export type DevConfig = z.infer<typeof devConfigSchema>;
export type DevCommand = z.infer<typeof commandSchema>;

export async function readDevConfig(worktree: string): Promise<DevConfig> {
  const file = await readFile(join(worktree, "dads.dev.json"), "utf8");
  const config = devConfigSchema.parse(JSON.parse(file));
  if (config.basePort + config.portsPerSlot * config.maxSlots > 65_536) {
    throw new Error("Configured slot ports exceed the TCP port range.");
  }
  const names = new Set(config.services.map((service) => service.name));
  const offsets = new Set(config.services.map((service) => service.portOffset));
  if (
    names.size !== config.services.length ||
    offsets.size !== config.services.length
  ) {
    throw new Error("Service names and port offsets must each be unique.");
  }
  if (
    config.services.some((service) => service.portOffset >= config.portsPerSlot)
  ) {
    throw new Error("A service port offset exceeds the slot's port block.");
  }
  return config;
}
