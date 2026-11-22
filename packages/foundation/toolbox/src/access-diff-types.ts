/** Type definitions for pure-IR `.zed` schema diffing. */

export type AccessDiffSafeChange =
  | { readonly kind: "added-resource"; readonly resource: string }
  | {
      readonly kind: "added-role";
      readonly resource: string;
      readonly role: string;
    }
  | {
      readonly kind: "widened-role";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "added-expiration";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "added-permission";
      readonly resource: string;
      readonly permission: string;
      readonly expression: string;
    }
  | {
      readonly kind: "modified-permission";
      readonly resource: string;
      readonly permission: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "removed-permission";
      readonly resource: string;
      readonly permission: string;
      readonly before: string;
    };

export type AccessDiffBreakingChange =
  | { readonly kind: "removed-resource"; readonly resource: string }
  | {
      readonly kind: "removed-role";
      readonly resource: string;
      readonly role: string;
    }
  | {
      readonly kind: "narrowed-role";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "removed-expiration";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    };

export type AccessPermissionChangeSummary = {
  readonly kind: "added" | "modified" | "removed";
  readonly resource: string;
  readonly permission: string;
  readonly before?: string;
  readonly after?: string;
  readonly description: string;
};

export type AccessSchemaDiff = {
  readonly safe: readonly AccessDiffSafeChange[];
  readonly breaking: readonly AccessDiffBreakingChange[];
  readonly permissionChanges: readonly AccessPermissionChangeSummary[];
  readonly requiresMigration: boolean;
  readonly summary: string;
};

export type DiffZedSchemasOptions = {
  readonly beforePath: string;
  readonly afterPath: string;
  readonly cwd?: string;
};

export type ZedSchemaDiffResult = {
  readonly beforePath: string;
  readonly afterPath: string;
  readonly diff: AccessSchemaDiff;
};
