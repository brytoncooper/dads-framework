import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { NoteId } from "../contract/wire.js";

export const noteTable = pgTable("starter_note", {
  id: uuid().primaryKey().$type<NoteId>(),
  tenantId: uuid("tenant_id").notNull(),
  text: text().notNull(),
});
