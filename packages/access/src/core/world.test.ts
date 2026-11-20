/**
 * What: world() is the typed scenario authoring surface.
 * Why: YAML scenarios become TS stories with compile-checked roles and
 * permissions — implicit same-owner merge is replaced by include().
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entityHandle } from "./entity-handle.js";
import { wildcard } from "./holders.js";
import { access } from "./model.js";
import { world } from "./world.js";

const idSchema = z.string();

describe("world()", () => {
  const Person = entityHandle({
    wireName: "user",
    idSchema,
  });
  const Site = entityHandle({
    wireName: "sites/site",
    idSchema,
  });
  const site = access(Site, {
    roles: {
      admin: Person,
      tenancy: wildcard(Person),
    },
    permissions: (roles) => ({
      view: [roles.admin],
      manage: [roles.admin],
    }),
  });

  it("emits written tuples and can/cannot assertions in authored order", () => {
    const casey = world(
      "site view",
      ({ user, write, expect: expectAccess }) => {
        const person = user("casey");
        write(site.roles.admin, "north").to(person);
        expectAccess(person).can(site.permissions.view, "north");
        expectAccess(person).cannot(site.permissions.manage, "south");
      },
    );

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
      const person = user("erin");
      write(site.roles.admin, "north").to(person);
      expectAccess(person).can(site.permissions.view, "north");
    });
    const combined = world(
      "combined",
      ({ include, user, expect: expectAccess }) => {
        include(base);
        const stranger = user("stranger");
        expectAccess(stranger).cannot(site.permissions.view, "north");
      },
    );

    expect(combined.relationships).toEqual([
      "sites/site:north#admin@user:erin",
    ]);
    expect(combined.assertions.true).toEqual([
      "sites/site:north#view@user:erin",
    ]);
    expect(combined.assertions.false).toEqual([
      "sites/site:north#view@user:stranger",
    ]);
  });

  it("writes wildcard and userset subjects", () => {
    const SetHandle = entityHandle({
      wireName: "sets/set",
      idSchema,
    });
    const permissionSet = access(SetHandle, {
      roles: {
        member: Person,
      },
      permissions: () => ({}),
    });

    const authored = world(
      "holders",
      ({ user, write, members, expect: expectAccess }) => {
        write(site.roles.tenancy, "north").to(wildcard(Person));
        write(site.roles.admin, "north").to(
          members(permissionSet.roles.member, "viewers"),
        );
        const person = user("casey");
        write(permissionSet.roles.member, "viewers").to(person);
        expectAccess(person).can(site.permissions.view, "north");
      },
    );

    expect(authored.relationships).toEqual([
      "sites/site:north#tenancy@user:*",
      "sites/site:north#admin@sets/set:viewers#member",
      "sets/set:viewers#member@user:casey",
    ]);
  });

  it("writes another entity as the subject", () => {
    const Organization = entityHandle({
      wireName: "organizations/organization",
      idSchema,
    });
    access(Organization, {
      roles: {},
      permissions: () => ({}),
    });

    const authored = world("owner", ({ entity, write }) => {
      write(site.roles.admin, "north").to(entity(Organization, "acme"));
    });

    expect(authored.relationships).toEqual([
      "sites/site:north#admin@organizations/organization:acme",
    ]);
  });

  it("asserts a permission for an entity subject", () => {
    const Organization = entityHandle({
      wireName: "organizations/organization",
      idSchema,
    });
    const organization = access(Organization, {
      roles: {},
      permissions: () => ({
        view: [],
      }),
    });

    const authored = world(
      "entity expect",
      ({ entity, expect: expectAccess }) => {
        expectAccess(entity(Organization, "acme")).can(
          organization.permissions.view,
          "acme",
        );
      },
    );

    expect(authored.assertions.true).toEqual([
      "organizations/organization:acme#view@organizations/organization:acme",
    ]);
  });
});
