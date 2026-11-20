import type {
  ScimUser,
  ScimUserData,
  ScimUserFilter,
} from "@dads-framework/identity/scim";
import { eq, sql } from "drizzle-orm";

import { tenantScimUser } from "./tenant-scim-table.js";

type DirectoryRow = typeof tenantScimUser.$inferSelect;

export function scimUserValues(data: ScimUserData) {
  return {
    userName: data.userName,
    userNameKey: data.userName.toLowerCase(),
    active: data.active,
    externalId: data.externalId ?? null,
    displayName: data.displayName ?? null,
    displayNameKey: data.displayName?.toLowerCase() ?? null,
    name: data.name ?? null,
    emails: data.emails ?? null,
    emailKeys: data.emails?.map((email) => email.value.toLowerCase()) ?? null,
  };
}

export function scimUserData(row: DirectoryRow): ScimUserData {
  return {
    userName: row.userName,
    active: row.active,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.emails === null ? {} : { emails: row.emails }),
  };
}

export function scimUserRecord(row: DirectoryRow): ScimUser {
  return {
    ...scimUserData(row),
    id: row.id,
    created: row.createdAt.toISOString(),
    lastModified: row.modifiedAt.toISOString(),
  };
}

export function scimUserFilter(filter: ScimUserFilter | undefined) {
  if (filter === undefined) return undefined;
  switch (filter.attribute) {
    case "id":
      return sql`${tenantScimUser.id}::text = ${filter.value}`;
    case "userName":
      return eq(tenantScimUser.userNameKey, filter.value.toLowerCase());
    case "externalId":
      return eq(tenantScimUser.externalId, filter.value);
    case "displayName":
      return eq(tenantScimUser.displayNameKey, filter.value.toLowerCase());
    case "emails.value":
      return sql`${filter.value.toLowerCase()} = ANY(${tenantScimUser.emailKeys})`;
    case "active":
      return eq(tenantScimUser.active, filter.value);
  }
}
