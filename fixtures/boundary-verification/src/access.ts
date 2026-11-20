import type { AccessIrDefinition } from "@dads-framework/access";

/** Portable policy with the same authoring/consumer separation as a deployed Zed file. */
export const boundaryVerificationModel: readonly AccessIrDefinition[] = [
  { wireName: "user", roles: [], permissions: [] },
  {
    wireName: "workspace",
    roles: [
      { name: "owner", subjects: [{ kind: "type", wireName: "user" }] },
      { name: "member", subjects: [{ kind: "type", wireName: "user" }] },
    ],
    permissions: [
      {
        name: "view",
        terms: [
          { kind: "role", name: "owner" },
          { kind: "role", name: "member" },
        ],
      },
    ],
  },
  {
    wireName: "document",
    roles: [
      {
        name: "workspace",
        subjects: [{ kind: "type", wireName: "workspace" }],
      },
      { name: "reader", subjects: [{ kind: "type", wireName: "user" }] },
    ],
    permissions: [
      {
        name: "view",
        terms: [
          { kind: "through", roleName: "workspace", targetPermission: "view" },
          { kind: "role", name: "reader" },
        ],
      },
    ],
  },
];
