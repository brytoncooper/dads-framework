import type { z } from "zod";

type AuditRowValue = z.infer<ReturnType<typeof z.json>>;

/** Identity columns copied by the trigger from the source table. */
export type AuditRowKey = Record<string, AuditRowValue>;

/** All columns in a source row, serialized by Postgres `to_jsonb`. */
export type AuditRowImage = Record<string, AuditRowValue>;

/** Scope dimension names and their non-null values at the time of the write. */
export type AuditScopeValues = Readonly<Record<string, string>>;
