import { pgTable, text, uuid } from "drizzle-orm/pg-core";

export const noteTable = pgTable("starter_note", {
  id: uuid().primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  text: text().notNull(),
});
