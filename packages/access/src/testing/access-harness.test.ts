import { describe, expect, it } from "vitest";

import {
  actor,
  allOf,
  anyOf,
  compileAccess,
  every,
  resource,
  roleToken,
  world,
} from "../index.js";
import {
  createAccessHarness,
  defineAccessScenario,
  proveAccess,
  proveScenario,
  proveScenarioSync,
  proveWorld,
  proveWorldSync,
} from "../runtime/testing.js";

function buildTestSchema() {
  const user = actor("user");
  const groupMemberRef = roleToken("app/group", "member", user.handle);
  const group = resource("app/group", {
    roles: {
      member: [user.expiring, user.anyone.expiring, groupMemberRef],
    },
    can: ({ member }) => ({ read: member }),
  });
  const workspace = resource("app/workspace", {
    roles: {
      owner: user.expiring,
      member: [user.expiring, group.roles.member.expiring, user.anyone],
      banned: user,
    },
    can: ({ owner, member, banned }) => ({
      view: anyOf(owner, member).unless(banned),
      admin: owner.unless(banned),
    }),
  });
  const folder = resource("app/folder", {
    parents: [workspace],
    recursive: true,
    roles: {
      viewer: user.expiring,
    },
    can: ({ parents, viewer }) => ({
      view: anyOf(viewer, parents.view),
    }),
  });
  const document = resource("app/document", {
    parents: [workspace, folder],
    roles: {
      viewer: [user.expiring, group.roles.member, user.anyone],
      approver: user,
      banned: user,
    },
    can: ({ parents, viewer, approver, banned }) => ({
      view: anyOf(parents.view, viewer).unless(banned),
      strict_view: every(parents).view,
      publish: allOf(viewer, approver).unless(banned),
    }),
  });
  return {
    user,
    group,
    workspace,
    folder,
    document,
    model: compileAccess([user, group, workspace, folder, document]),
  };
}

describe("createAccessHarness (zero-await policy testing)", () => {
  it("evaluates inheritance, cycles, groups, expiration, revocation, and bans synchronously", () => {
    const { user, group, workspace, folder, document, model } =
      buildTestSchema();
    const access = createAccessHarness(model);
    const alice = access.actor(user, "alice");
    const bob = user("bob");
    const stranger = access.actor(user, "stranger");

    // Mix token style and instance-proxy style seamlessly, zero awaits
    access.grant(workspace.roles.owner, "workspace-1").to(alice);
    access.grant(folder.roles.parent, "folder-1").to(workspace, "workspace-1");
    access.grant(folder.roles.parent, "folder-2").to(folder, "folder-1");
    // Deliberate folder cycle: folder-1 -> folder-2 -> folder-1
    access.grant(folder.roles.parent, "folder-1").to(folder, "folder-2");
    access.grant(document("doc-1").parent).to(folder("folder-2"));

    // Group + expiring direct grant for Bob
    access.grant(group.roles.member, "team-1").expiringIn("1h").to(bob);
    access
      .grant(document.roles.viewer, "doc-1")
      .to(access.members(group.roles.member, "team-1"));
    access.grant(document.roles.approver, "doc-1").to(bob);

    access.assertCan(alice, document.permissions.view, "doc-1");
    access.assertCan(bob, document("doc-1").publish);
    access.assertCannot(stranger, document.permissions.view, "doc-1");
    access.assertVisible(alice, document.permissions.view, ["doc-1"]);

    // Advance clock past 1h: Bob's group membership expires
    access.advanceTime("2h");
    access.assertCannot(bob, document.permissions.view, "doc-1");
    access.assertCannot(bob, document.permissions.publish, "doc-1");

    // Ban overrides Alice's inherited workspace ownership
    access.grant(document.roles.banned, "doc-1").to(alice);
    access.assertCannot(alice, document.permissions.view, "doc-1");

    // Revoking the ban restores Alice's inherited access
    access.revoke(document.roles.banned, "doc-1").from(alice);
    access.assertCan(alice, document.permissions.view, "doc-1");
  });

  it("explains why a check failed for bans, expired grants, and empty every()", () => {
    const { user, workspace, document, model } = buildTestSchema();
    const access = createAccessHarness(model);
    const alice = access.actor(user, "alice");
    const bob = access.actor(user, "bob");

    access.grant(workspace.roles.owner, "workspace-1").to(alice);
    access.grant(document.roles.parent, "doc-1").to(workspace, "workspace-1");
    access.grant(document.roles.banned, "doc-1").to(alice);

    expect(() => {
      access.assertCan(alice, document.permissions.view, "doc-1");
    }).toThrow(/BLOCKED[\s\S]*app\/document:doc-1#banned@user:alice/);

    access.grant(document.roles.viewer, "doc-2").expiringIn("30m").to(bob);
    access.advanceTime("90m");

    expect(() => {
      access.assertCan(bob, document.permissions.view, "doc-2");
    }).toThrow(/expired 1h ago: app\/document:doc-2#viewer@user:bob/);

    // Non-vacuous every(parents) with zero parents
    expect(() => {
      access.assertCan(alice, document.permissions.strict_view, "orphan-doc");
    }).toThrow(/no active parent relationship/);
  });

  it("verifies permission matrices and prints a diff table on mismatch", () => {
    const { user, workspace, document, model } = buildTestSchema();
    const access = createAccessHarness(model);
    const owner = access.actor(user, "owner");
    const publisher = access.actor(user, "publisher");
    const stranger = access.actor(user, "stranger");

    access.grant(workspace.roles.owner, "workspace-1").to(owner);
    access.grant(document.roles.parent, "doc-1").to(workspace, "workspace-1");
    access.grant(document.roles.viewer, "doc-1").to(publisher);
    access.grant(document.roles.approver, "doc-1").to(publisher);

    access.assertMatrix(document, "doc-1", {
      permissions: [
        document.permissions.view,
        document.permissions.strict_view,
        document.permissions.publish,
      ],
      cases: [
        [owner, ["allow", "allow", "deny"]],
        [publisher, ["allow", "deny", "allow"]],
        [stranger, ["deny", "deny", "deny"]],
      ],
    });

    expect(() => {
      access.assertMatrix(document, "doc-1", {
        permissions: [document.permissions.view, document.permissions.publish],
        cases: [[owner, ["allow", "allow"]]],
      });
    }).toThrow(/allow \(got deny\)/);
  });
});

describe("executable world(), defineAccessScenario(), and proveAccess()", () => {
  it("executes existing world() definitions synchronously and asynchronously", async () => {
    const { workspace, document, model } = buildTestSchema();
    const sharingWorld = world(
      "workspace owner reads child document",
      ({ user: person, entity, write, expect: expectAccess }) => {
        const alice = person("alice");
        const stranger = person("stranger");
        write(workspace.roles.owner, "workspace-1").to(alice);
        write(document.roles.parent, "doc-1").to(
          entity(workspace, "workspace-1"),
        );
        expectAccess(alice).can(document.permissions.view, "doc-1");
        expectAccess(stranger).cannot(document.permissions.view, "doc-1");
      },
    );

    proveWorldSync(model, sharingWorld);
    await proveWorld(model, sharingWorld);
  });

  it("composes reusable scenarios with include() and runs under a single await", async () => {
    const { user, workspace, document, model } = buildTestSchema();

    const baseWorkspace = defineAccessScenario(
      "workspace setup",
      (scenario) => {
        const alice = scenario.actor(user, "alice");
        scenario.grant(workspace.roles.owner, "workspace-1").to(alice);
        scenario
          .grant(document.roles.parent, "doc-1")
          .to(workspace, "workspace-1");
      },
    );

    const expirationScenario = defineAccessScenario(
      "expiring guest viewer",
      (scenario) => {
        scenario.include(baseWorkspace);
        const alice = scenario.actor(user, "alice");
        const guest = scenario.actor(user, "guest");
        scenario
          .grant(document.roles.viewer, "doc-1")
          .expiringIn("15m")
          .to(guest);
        scenario.assertCan(alice, document.permissions.view, "doc-1");
        scenario.assertCan(guest, document.permissions.view, "doc-1");
        scenario.advanceTime("30m");
        scenario.assertCannot(guest, document.permissions.view, "doc-1");
      },
    );

    proveScenarioSync(model, expirationScenario);
    await proveScenario(model, expirationScenario);
    await proveAccess(model, {}, (scenario) => {
      const alice = scenario.actor(user, "alice");
      scenario.grant(document.roles.viewer, "doc-1").to(user.anyone);
      scenario.assertCan(alice, document.permissions.view, "doc-1");
      scenario.assertVisible(alice, document.permissions.view, ["doc-1"]);
    });
  });
});
