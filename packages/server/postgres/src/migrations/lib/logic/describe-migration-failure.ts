import { z } from "zod";

const migrationFailureSchema = z.object({
  name: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});

export type MigrationFailure = {
  readonly name: string;
  readonly driverCode?: string;
};

/** Keeps operational discriminants while excluding messages and connection data. */
export function describeMigrationFailure(error: unknown): MigrationFailure {
  const parsed = migrationFailureSchema.safeParse(error);
  if (!parsed.success) {
    return { name: "UnknownError" };
  }
  return {
    name: parsed.data.name ?? "Error",
    ...(parsed.data.code === undefined
      ? {}
      : { driverCode: String(parsed.data.code) }),
  };
}
