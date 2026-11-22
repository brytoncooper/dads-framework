import { actor, anyOf, compileAccess, resource } from "@dads-framework/access";

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
});

export const document = resource("document", {
  roles: {
    org: organization,
    owner: user,
    viewer: user,
    banned: user,
  },
  can: ({ org, owner, viewer, banned }) => ({
    view: anyOf(owner, viewer, org.view).unless(banned),
    edit: anyOf(owner, org.manage).unless(banned),
  }),
});

export const accessModel = compileAccess([user, organization, document]);
