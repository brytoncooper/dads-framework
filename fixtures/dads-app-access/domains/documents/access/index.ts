import { actor, anyOf, compileAccess, resource } from "@dads-framework/access";
import { fromParam, requires } from "@dads-framework/http";

export const user = actor("user");

export const organization = resource("organization", {
  roles: {
    admin: user,
    member: user,
  },
  can: ({ admin, member }) => ({
    manage: admin,
    view: anyOf(admin, member),
  }),
  children: {
    document: {
      inherit: "all",
      roles: {
        owner: user,
        viewer: user,
        banned: user,
      },
      can: ({ owner, viewer, banned, parent }) => ({
        view: anyOf(owner, viewer, parent.view).unless(banned),
        edit: anyOf(owner, parent.manage).unless(banned),
      }),
    },
    billing: {
      inherit: ["manage"],
      roles: { accountant: user },
      can: ({ accountant }) => ({ view: accountant }),
    },
  },
});

export const document = organization.document;
export const documentsAccessModel = compileAccess([user, organization]);

/** Typed HTTP route guards — database-free and safe to import in domains/. */
export const canViewDocument = requires(document.permissions.view, fromParam("documentId"));
export const canEditDocument = requires(document.permissions.edit, fromParam("documentId"));
