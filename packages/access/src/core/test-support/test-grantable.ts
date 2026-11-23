import { grantable, type GrantableDirectSubject, type GrantableRole } from "../../catalog.js";
import { actor, resource } from "../../index.js";

const user = actor("user");
const group = resource("access_management/permission_set", {
  roles: { member: user },
});

type TestGrantableOverrides = {
  readonly directSubject?: GrantableDirectSubject;
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
};

const DEFAULT_GRANTABLE: Parameters<typeof grantable>[0] = {
  directSubject: user,
  groupSubject: group.roles.member,
  id: "test.capability",
  label: { en: "Test capability" },
  description: { en: "Test description" },
  group: { name: "products", label: { en: "Products" } },
  domainId: "test",
  domainLabel: { en: "Test" },
  scopes: ["ORGANIZATION"],
  permission: "view",
};

/** Minimal grantable for kit unit tests that are not about catalog metadata. */
export function testGrantable(overrides: TestGrantableOverrides = {}): GrantableRole {
  return grantable({
    ...DEFAULT_GRANTABLE,
    ...overrides,
  });
}
