import { z } from "zod";

const failureSchema = z.object({ code: z.string() });

export function migrationStatusFailure(
  error: unknown,
): "database-ahead" | "checksum-mismatch" | undefined {
  const parsed = failureSchema.safeParse(error);
  if (!parsed.success || !parsed.data.code.startsWith("NODE_PG_MIGRATION_"))
    return undefined;
  return [
    "NODE_PG_MIGRATION_CHECKSUM_MISSING",
    "NODE_PG_MIGRATION_CHECKSUM_MISMATCH",
  ].includes(parsed.data.code)
    ? "checksum-mismatch"
    : "database-ahead";
}
