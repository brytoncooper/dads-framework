import type { UsersetHolder } from "./holders.js";
import type { EntityHandle } from "./entity-handle.js";

export type GrantableLocalizedText = Readonly<Record<string, string>>;

/** A scope name supplied by the application. */
export type GrantableScope = string;

export type GrantableTargetKind = "NONE" | "RESOURCE";

export type GrantableRisk = "STANDARD" | "DANGEROUS";

/**
 * Editor placement for a grantable role. `null` means the capability is
 * resolved and listed for grant machinery but has no permissions-editor group.
 */
export type GrantableGroup = {
  readonly name: string;
  readonly label: GrantableLocalizedText;
  /** One line shown under the group name; roles in a group must agree on it. */
  readonly description?: GrantableLocalizedText;
  /** Position among groups, ascending; groups without one list last. */
  readonly order?: number;
} | null;

/**
 * A role customers may grant through a permission set. Also the registration
 * for the generated grantable / capability catalog.
 */
export type GrantableRole = {
  readonly kind: "grantable";
  readonly directSubject: EntityHandle;
  readonly groupSubject?: UsersetHolder;
  readonly id: string;
  readonly label: GrantableLocalizedText;
  readonly description: GrantableLocalizedText;
  readonly group: GrantableGroup;
  readonly domainId: string;
  readonly domainLabel: GrantableLocalizedText;
  readonly requires: readonly string[];
  readonly scopes: readonly GrantableScope[];
  readonly customerAssignable: boolean;
  readonly targetKind: GrantableTargetKind;
  readonly risk: GrantableRisk;
  /** Permission verb unlocked by holding this role (SpiceDB permission name). */
  readonly permission: string;
};

/**
 * Declare a permission-set-grantable role. Also the catalog registration.
 */
export function grantable(spec: {
  readonly directSubject: EntityHandle;
  readonly groupSubject?: UsersetHolder;
  readonly id: string;
  readonly label: GrantableLocalizedText;
  readonly description: GrantableLocalizedText;
  readonly group: GrantableGroup;
  readonly domainId: string;
  readonly domainLabel: GrantableLocalizedText;
  readonly requires?: readonly string[];
  readonly scopes: readonly GrantableScope[];
  readonly customerAssignable?: boolean;
  readonly targetKind?: GrantableTargetKind;
  readonly risk?: GrantableRisk;
  readonly permission: string;
}): GrantableRole {
  return {
    kind: "grantable",
    directSubject: spec.directSubject,
    ...(spec.groupSubject === undefined
      ? {}
      : { groupSubject: spec.groupSubject }),
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group,
    domainId: spec.domainId,
    domainLabel: spec.domainLabel,
    requires: spec.requires ?? [],
    scopes: spec.scopes,
    customerAssignable: spec.customerAssignable ?? true,
    targetKind: spec.targetKind ?? "NONE",
    risk: spec.risk ?? "STANDARD",
    permission: spec.permission,
  };
}

export function isGrantableRole(value: unknown): value is GrantableRole {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "grantable"
  );
}
