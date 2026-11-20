import { count, desc, eq, sql, type SQL } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import { type EmailEnvelope, emailEnvelopeSchema } from "../email-envelope.js";
import type {
  OutboundEmailId,
  OutboundEmailStatus,
} from "../outbound-email-status.js";
import { outboundEmail } from "./generated-tables/outbound-emails.tables.js";
import { outboundEmailPropsSchema } from "./outbound-email-props.js";

/** One outbox row as an operator reads it back: what was asked for and how it went. */
export type OutboundEmailLogEntry = {
  readonly id: OutboundEmailId;
  readonly templateName: string;
  readonly props: Record<string, unknown>;
  /** Null when the stored envelope no longer matches the envelope schema. */
  readonly envelope: EmailEnvelope | null;
  readonly status: OutboundEmailStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly sendAt: Date;
  readonly sentAt: Date | null;
};

export type OutboundEmailLogQuery = {
  /** Part of a To, Cc or Bcc address, matched case-insensitively. */
  readonly recipient?: string;
  readonly offset: number;
  readonly limit: number;
};

export type OutboundEmailLogPage = {
  readonly rows: readonly OutboundEmailLogEntry[];
  readonly total: number;
};

/**
 * Reads the outbox newest first, for an operator who needs to see what was
 * queued and how it went. Read-only: it holds no transition, so nothing that
 * reads the log can change a row's delivery.
 */
export class DrizzleOutboundEmailLog {
  constructor(private readonly db: DrizzleHandle) {}

  async list(query: OutboundEmailLogQuery): Promise<OutboundEmailLogPage> {
    const where =
      query.recipient === undefined ? undefined : addressedTo(query.recipient);
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(outboundEmail)
        .where(where)
        // Ids are UUIDv7, so the id breaks a tie in creation order too.
        .orderBy(desc(outboundEmail.createdAt), desc(outboundEmail.id))
        .offset(query.offset)
        .limit(query.limit),
      this.db.select({ total: count() }).from(outboundEmail).where(where),
    ]);
    return { rows: rows.map(toLogEntry), total: totals[0]?.total ?? 0 };
  }

  async find(id: OutboundEmailId): Promise<OutboundEmailLogEntry | null> {
    const [row] = await this.db
      .select()
      .from(outboundEmail)
      .where(eq(outboundEmail.id, id))
      .limit(1);
    return row ? toLogEntry(row) : null;
  }
}

/** Any To, Cc or Bcc address containing the text, with LIKE wildcards taken literally. */
function addressedTo(recipient: string): SQL {
  const pattern = `%${recipient.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      coalesce(${outboundEmail.envelope} -> 'to', '[]'::jsonb)
      || coalesce(${outboundEmail.envelope} -> 'cc', '[]'::jsonb)
      || coalesce(${outboundEmail.envelope} -> 'bcc', '[]'::jsonb)
    ) AS recipient
    WHERE recipient ->> 'address' ILIKE ${pattern}
  )`;
}

function toLogEntry(
  row: typeof outboundEmail.$inferSelect,
): OutboundEmailLogEntry {
  const envelope = emailEnvelopeSchema.safeParse(row.envelope);
  return {
    id: row.id,
    templateName: row.templateName,
    props: outboundEmailPropsSchema.parse(row.props),
    envelope: envelope.success ? envelope.data : null,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sendAt: row.sendAt,
    sentAt: row.sentAt,
  };
}
