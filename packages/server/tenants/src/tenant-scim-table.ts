import type { ScimEmail, ScimName } from "@dads-framework/identity/scim";
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { TenantId } from "./tenant-access.js";
import { tenantTable } from "./tenant-tables.js";

export const tenantScimUser = pgTable(
  "tenant_scim_user",
  {
    tenantId: uuid("tenant_id")
      .$type<TenantId>()
      .notNull()
      .references(() => tenantTable.id),
    id: uuid("id").notNull(),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull(),
    active: boolean("active").notNull(),
    externalId: text("external_id"),
    displayName: text("display_name"),
    displayNameKey: text("display_name_key"),
    name: jsonb("name").$type<ScimName>(),
    emails: jsonb("emails").$type<readonly ScimEmail[]>(),
    emailKeys: text("email_keys").array(),
    accountId: text("account_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    modifiedAt: timestamp("modified_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);
