import { z } from "zod";

const environment = z.object({
  DATABASE_URL: z.url(),
  DADS_IDENTITY_SECRET: z.string().min(32),
  DADS_API: z.enum(["customer", "staff"]).default("customer"),
  DADS_BASE_URL: z.url().optional(),
  DADS_PREPARE_PERMISSION_CHECKS: z.enum(["0", "1"]).default("0"),
  DADS_FILE_STORAGE_DIR: z.string().min(1).default(".dads/files"),
  DADS_MAIL_SPOOL_DIR: z.string().min(1).default(".dads/mail"),
  DADS_DEV_LOG_MAIL: z.enum(["0", "1"]).default("0"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().default("development"),
});

export function readEnvironment(source: NodeJS.ProcessEnv) {
  const parsed = environment.parse(source);
  return {
    ...parsed,
    baseUrl: parsed.DADS_BASE_URL ?? `http://127.0.0.1:${String(parsed.PORT)}`,
  };
}
