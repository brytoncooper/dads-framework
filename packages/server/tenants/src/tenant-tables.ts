import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { TenantId, TenantRole } from "./tenant-access.js";

export const tenantTable = pgTable("tenant", {
  id: uuid("id").$type<TenantId>().primaryKey(),
  name: text("name").notNull(),
});

export const tenantMembership = pgTable(
  "tenant_membership",
  {
    tenantId: uuid("tenant_id")
      .$type<TenantId>()
      .notNull()
      .references(() => tenantTable.id),
    accountId: text("account_id").notNull(),
    role: text("role").$type<TenantRole>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.accountId] })],
);

export const tenantInvitation = pgTable("tenant_invitation", {
  tokenHash: text("token_hash").primaryKey(),
  tenantId: uuid("tenant_id")
    .$type<TenantId>()
    .notNull()
    .references(() => tenantTable.id),
  recipientEmail: text("recipient_email").notNull(),
  issuedBy: text("issued_by").notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
});
