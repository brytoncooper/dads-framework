export type ScimName = {
  readonly formatted?: string;
  readonly familyName?: string;
  readonly givenName?: string;
  readonly middleName?: string;
  readonly honorificPrefix?: string;
  readonly honorificSuffix?: string;
};

export type ScimEmail = {
  readonly value: string;
  readonly type?: string;
  readonly primary?: boolean;
  readonly display?: string;
};

export type ScimUserData = {
  readonly userName: string;
  readonly active: boolean;
  readonly externalId?: string;
  readonly displayName?: string;
  readonly name?: ScimName;
  readonly emails?: readonly ScimEmail[];
};

export type ScimUser = ScimUserData & {
  readonly id: string;
  readonly created: string;
  readonly lastModified: string;
};

export type ScimUserFilter =
  | {
      readonly attribute: "id" | "userName" | "externalId" | "displayName" | "emails.value";
      readonly value: string;
    }
  | { readonly attribute: "active"; readonly value: boolean };

export type ScimUserQuery = {
  readonly startIndex: number;
  readonly count: number;
  readonly filter?: ScimUserFilter;
};

export type ScimDirectory = {
  /** Scope and filter before counting and paginating in stable order. */
  readonly list: (
    tenantId: string,
    query: ScimUserQuery,
  ) => Promise<{
    readonly users: readonly ScimUser[];
    readonly totalResults: number;
  }>;
  readonly get: (tenantId: string, id: string) => Promise<ScimUser | null>;
  /** Generate a permanent SCIM identifier and enforce userName uniqueness within the tenant. */
  readonly create: (tenantId: string, user: ScimUserData) => Promise<ScimUser | "conflict">;
  /** Apply the callback to the current user atomically. A thrown error must leave the user unchanged. */
  readonly update: (
    tenantId: string,
    id: string,
    change: (current: ScimUserData) => ScimUserData,
  ) => Promise<ScimUser | "conflict" | null>;
  /** Deleted users disappear from lookup and listing, and their identifiers cannot be reused. */
  readonly delete: (tenantId: string, id: string) => Promise<boolean>;
};

export function matchesScimUserFilter(user: ScimUser, filter: ScimUserFilter): boolean {
  switch (filter.attribute) {
    case "active":
    case "id":
    case "externalId":
      return user[filter.attribute] === filter.value;
    case "userName":
    case "displayName":
      return user[filter.attribute]?.toLowerCase() === filter.value.toLowerCase();
    case "emails.value":
      return user.emails?.some((email) => email.value.toLowerCase() === filter.value.toLowerCase()) ?? false;
  }
}
