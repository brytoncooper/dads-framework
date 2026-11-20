export type ScimGroupMember = { readonly value: string };

export type ScimGroupData = {
  readonly displayName: string;
  readonly externalId?: string;
  readonly members: readonly ScimGroupMember[];
};

export type ScimGroup = ScimGroupData & {
  readonly id: string;
  readonly created: string;
  readonly lastModified: string;
};

export type ScimGroupQuery = {
  readonly startIndex: number;
  readonly count: number;
  readonly filter?: {
    readonly attribute: "id" | "displayName" | "externalId";
    readonly value: string;
  };
};

export type ScimGroupDirectory = {
  readonly list: (
    tenantId: string,
    query: ScimGroupQuery,
  ) => Promise<{
    readonly groups: readonly ScimGroup[];
    readonly totalResults: number;
  }>;
  readonly get: (tenantId: string, id: string) => Promise<ScimGroup | null>;
  readonly create: (
    tenantId: string,
    data: ScimGroupData,
  ) => Promise<ScimGroup | "conflict" | "invalidMember">;
  /** Commit the callback and validate tenant member references in the same transaction. */
  readonly update: (
    tenantId: string,
    id: string,
    change: (current: ScimGroupData) => ScimGroupData,
  ) => Promise<ScimGroup | "conflict" | "invalidMember" | null>;
  readonly delete: (tenantId: string, id: string) => Promise<boolean>;
};
