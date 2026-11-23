import type {
  GrantableGroup,
  GrantableLocalizedText,
  GrantableRisk,
  GrantableScope,
  GrantableTargetKind,
} from "./grantable.js";

/**
 * Catalog row that is not a SpiceDB grantable role — system-only capabilities
 * that must appear in the generated catalog without adding a relation.
 */
export type CatalogOnlyCapability = {
  readonly kind: "catalogOnly";
  readonly id: string;
  readonly label: GrantableLocalizedText;
  readonly description: GrantableLocalizedText;
  readonly group: GrantableGroup;
  readonly domainId: string;
  readonly domainLabel: GrantableLocalizedText;
  readonly requires: readonly string[];
  readonly scopes: readonly GrantableScope[];
  readonly customerAssignable: false;
  readonly targetKind: GrantableTargetKind;
  readonly risk: GrantableRisk;
  readonly entityWireName: string;
  readonly roleName: string;
  readonly permission: string;
};

/**
 * Declare a system-only catalog capability that must not add a SpiceDB role.
 */
export function catalogOnly(spec: {
  readonly id: string;
  readonly label: GrantableLocalizedText;
  readonly description: GrantableLocalizedText;
  readonly group?: GrantableGroup;
  readonly domainId: string;
  readonly domainLabel: GrantableLocalizedText;
  readonly requires?: readonly string[];
  readonly scopes: readonly GrantableScope[];
  readonly targetKind?: GrantableTargetKind;
  readonly risk?: GrantableRisk;
  readonly entityWireName: string;
  readonly roleName: string;
  readonly permission: string;
}): CatalogOnlyCapability {
  return {
    kind: "catalogOnly",
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group ?? null,
    domainId: spec.domainId,
    domainLabel: spec.domainLabel,
    requires: spec.requires ?? [],
    scopes: spec.scopes,
    customerAssignable: false,
    targetKind: spec.targetKind ?? "NONE",
    risk: spec.risk ?? "DANGEROUS",
    entityWireName: spec.entityWireName,
    roleName: spec.roleName,
    permission: spec.permission,
  };
}

export function isCatalogOnlyCapability(value: unknown): value is CatalogOnlyCapability {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "catalogOnly";
}
