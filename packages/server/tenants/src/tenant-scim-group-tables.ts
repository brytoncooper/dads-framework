import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { TenantId } from "./tenant-access.js";
import { tenantTable } from "./tenant-tables.js";

export const tenantScimGroup = pgTable(
  "tenant_scim_group",
  {
    tenantId: uuid("tenant_id")
      .$type<TenantId>()
      .notNull()
      .references(() => tenantTable.id),
    id: uuid("id").notNull(),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull(),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    modifiedAt: timestamp("modified_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);

export const tenantScimGroupMember = pgTable(
  "tenant_scim_group_member",
  {
    tenantId: uuid("tenant_id").$type<TenantId>().notNull(),
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.groupId, table.userId] }),
  ],
);
