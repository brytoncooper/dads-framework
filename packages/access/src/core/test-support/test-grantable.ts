import { grantable, type GrantableRole } from "../grantable.js";
import { z } from "zod";
import { entityHandle } from "../entity-handle.js";
import { membersOf } from "../holders.js";
import { access } from "../model.js";

const user = entityHandle({ wireName: "user", idSchema: z.string() });
const group = access(
  entityHandle({
    wireName: "access_management/permission_set",
    idSchema: z.string(),
  }),
  { roles: { member: user }, permissions: () => ({}) },
);

/** Minimal grantable for kit unit tests that are not about catalog metadata. */
export function testGrantable(
  overrides: {
    readonly id?: string;
    readonly label?: GrantableRole["label"];
    readonly description?: GrantableRole["description"];
    readonly group?: GrantableRole["group"];
    readonly domainId?: string;
    readonly domainLabel?: GrantableRole["domainLabel"];
    readonly requires?: readonly string[];
    readonly scopes?: GrantableRole["scopes"];
    readonly customerAssignable?: boolean;
    readonly targetKind?: GrantableRole["targetKind"];
    readonly risk?: GrantableRole["risk"];
    readonly permission?: string;
  } = {},
): GrantableRole {
  return grantable({
    directSubject: user,
    groupSubject: membersOf(group.roles.member),
    id: overrides.id ?? "test.capability",
    label: overrides.label ?? { en: "Test capability" },
    description: overrides.description ?? { en: "Test description" },
    group:
      overrides.group === undefined
        ? { name: "products", label: { en: "Products" } }
        : overrides.group,
    domainId: overrides.domainId ?? "test",
    domainLabel: overrides.domainLabel ?? { en: "Test" },
    scopes: overrides.scopes ?? ["ORGANIZATION"],
    ...optionalOverrides(overrides),
    permission: overrides.permission ?? "view",
  });
}

/** The overrides grantable() defaults itself, passed only when given. */
function optionalOverrides(overrides: {
  readonly requires?: readonly string[];
  readonly customerAssignable?: boolean;
  readonly targetKind?: GrantableRole["targetKind"];
  readonly risk?: GrantableRole["risk"];
}): {
  requires?: readonly string[];
  customerAssignable?: boolean;
  targetKind?: GrantableRole["targetKind"];
  risk?: GrantableRole["risk"];
} {
  return {
    ...(overrides.requires === undefined
      ? {}
      : { requires: overrides.requires }),
    ...(overrides.customerAssignable === undefined
      ? {}
      : { customerAssignable: overrides.customerAssignable }),
    ...(overrides.targetKind === undefined
      ? {}
      : { targetKind: overrides.targetKind }),
    ...(overrides.risk === undefined ? {} : { risk: overrides.risk }),
  };
}
