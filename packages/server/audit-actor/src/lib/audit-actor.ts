/** Actor identity and the Postgres setting used by the audit trigger. */
import { z } from "zod";

/**
 * The Postgres run-time setting the attributed pool writes with `set_config`
 * and the `audit_record` trigger reads with `current_setting`. The trigger
 * refuses the write when it is empty, so this name is a contract between the
 * pool and the migration, not a convention.
 */
export const AUDIT_ACTOR_SETTING = "dads.audit_actor";

/** Built-in actor kinds. Applications may define additional kinds. */
export const AUDIT_ACTOR_KINDS = ["user", "system", "anonymous"] as const;

/** Applications can use additional lowercase identifiers for their actors. */
const auditActorKindSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u)
  .refine((kind) => kind !== "unattributed");

export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

/**
 * `id` is empty only for `anonymous`. `requestId` is always present: it is
 * what joins an `audit_log` row to its `request_log` row, so an actor without
 * one cannot be attributed to anything.
 */
export const auditActorSchema = z.strictObject({
  kind: auditActorKindSchema,
  id: z.string(),
  requestId: z.string().min(1),
  reason: z.string().max(512).optional(),
  /**
   * The OAuth client a person acted through (an MCP client such as Claude or
   * ChatGPT): its registered client id, and the name it registered under at
   * the time. Absent for the web and every other caller.
   */
  clientId: z.string().max(255).optional(),
  clientName: z.string().max(255).optional(),
});

export type AuditActor = z.infer<typeof auditActorSchema>;

/** Serialize the actor using the field names consumed by the trigger. */
export function serializeAuditActor(actor: AuditActor): string {
  return JSON.stringify({
    kind: auditActorKindSchema.parse(actor.kind),
    id: actor.id,
    requestId: actor.requestId,
    reason: actor.reason,
    clientId: actor.clientId,
    clientName: actor.clientName,
  });
}

/**
 * Reads back what `serializeAuditActor` wrote. Returns `null` rather than
 * throwing for anything unreadable — an empty setting, malformed JSON, or a
 * shape this build does not recognize — because the caller reading the
 * setting is diagnosing attribution, not enforcing it. The trigger is what
 * enforces it, in the database.
 */
export function parseAuditActor(text: string): AuditActor | null {
  if (text.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }

  const actor = auditActorSchema.safeParse(decoded);
  return actor.success ? actor.data : null;
}
