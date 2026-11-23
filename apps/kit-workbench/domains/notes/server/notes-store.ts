import type { DrizzleHandle } from "@dads-framework/postgres";
import { tenantIdSchema, type TenantId } from "@dads-framework/identity/tenants";
import { count, eq } from "drizzle-orm";
import { noteTable } from "./tables.js";

export type NoteRecord = {
  readonly id: string;
  readonly text: string;
  readonly tenantId: TenantId;
};

export type ListTenantNotesInput = {
  readonly tenantId: TenantId;
  readonly page: number;
  readonly perPage: number;
};

export type ListTenantNotesResult = {
  readonly items: readonly NoteRecord[];
  readonly total: number;
};

export type NoteWriteTransaction = Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0];

export type NotesStore = {
  listNotes(input: ListTenantNotesInput): Promise<ListTenantNotesResult>;
  insertNote(tx: NoteWriteTransaction, value: NoteRecord): Promise<NoteRecord>;
};

export async function listTenantNotes(
  db: DrizzleHandle,
  { tenantId, page, perPage }: ListTenantNotesInput,
): Promise<ListTenantNotesResult> {
  const scope = eq(noteTable.tenantId, tenantId);
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(noteTable)
      .where(scope)
      .orderBy(noteTable.id)
      .limit(perPage)
      .offset((page - 1) * perPage),
    db.select({ total: count() }).from(noteTable).where(scope),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      text: row.text,
      tenantId: tenantIdSchema.parse(row.tenantId),
    })),
    total: totals[0]?.total ?? 0,
  };
}

export async function insertTenantNote(tx: NoteWriteTransaction, value: NoteRecord): Promise<NoteRecord> {
  await tx.insert(noteTable).values(value);
  return value;
}

export function createNotesStore(db: DrizzleHandle): NotesStore {
  return {
    listNotes: (input) => listTenantNotes(db, input),
    insertNote: (tx, value) => insertTenantNote(tx, value),
  };
}
