/**
 * What: world() is the typed scenario authoring surface.
 * Why: YAML scenarios become TS stories with compile-checked roles and
 * permissions — implicit same-owner merge is replaced by include().
 */
import { describe, expect, it } from "vitest";

import { actor, resource, world } from "../index.js";

describe("world()", () => {
  const person = actor("user");
  const site = resource("sites/site", {
    roles: {
      admin: person,
      tenancy: person.anyone,
    },
    can: ({ admin }) => ({
      view: admin,
      manage: admin,
    }),
  });

  it("emits written tuples and can/cannot assertions in authored order", () => {
    const casey = world("site view", ({ user, write, expect: expectAccess }) => {
      const subject = user("casey");
      write(site.roles.admin, "north").to(subject);
      expectAccess(subject).can(site.permissions.view, "north");
      expectAccess(subject).cannot(site.permissions.manage, "south");
    });

    expect(casey).toEqual({
      title: "site view",
      relationships: ["sites/site:north#admin@user:casey"],
      assertions: {
        true: ["sites/site:north#view@user:casey"],
        false: ["sites/site:south#manage@user:casey"],
      },
    });
  });

  it("includes another world's facts and assertions without a receiver", () => {
    const base = world("base", ({ user, write, expect: expectAccess }) => {
      const subject = user("erin");
      write(site.roles.admin, "north").to(subject);
      expectAccess(subject).can(site.permissions.view, "north");
    });
    const combined = world("combined", ({ include, user, expect: expectAccess }) => {
      include(base);
      const stranger = user("stranger");
      expectAccess(stranger).cannot(site.permissions.view, "north");
    });

    expect(combined.relationships).toEqual(["sites/site:north#admin@user:erin"]);
    expect(combined.assertions.true).toEqual(["sites/site:north#view@user:erin"]);
    expect(combined.assertions.false).toEqual(["sites/site:north#view@user:stranger"]);
  });

  it("writes wildcard and userset subjects", () => {
    const permissionSet = resource("sets/set", {
      roles: { member: person },
    });

    const authored = world("holders", ({ user, write, members, expect: expectAccess }) => {
      write(site.roles.tenancy, "north").to(person.anyone);
      write(site.roles.admin, "north").to(members(permissionSet.roles.member, "viewers"));
      const subject = user("casey");
      write(permissionSet.roles.member, "viewers").to(subject);
      expectAccess(subject).can(site.permissions.view, "north");
    });

    expect(authored.relationships).toEqual([
      "sites/site:north#tenancy@user:*",
      "sites/site:north#admin@sets/set:viewers#member",
      "sets/set:viewers#member@user:casey",
    ]);
  });

  it("writes another entity as the subject", () => {
    const organization = resource("organizations/organization", {});

    const authored = world("owner", ({ entity, write }) => {
      write(site.roles.admin, "north").to(entity(organization, "acme"));
    });

    expect(authored.relationships).toEqual(["sites/site:north#admin@organizations/organization:acme"]);
  });

  it("asserts a permission for an entity subject", () => {
    const organization = resource("organizations/organization", {
      roles: { admin: person },
      can: ({ admin }) => ({ view: admin }),
    });

    const authored = world("entity expect", ({ entity, expect: expectAccess }) => {
      expectAccess(entity(organization, "acme")).can(organization.permissions.view, "acme");
    });

    expect(authored.assertions.true).toEqual(["organizations/organization:acme#view@organizations/organization:acme"]);
  });
});
