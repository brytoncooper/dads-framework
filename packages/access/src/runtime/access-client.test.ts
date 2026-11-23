import { describe, expect, it } from "vitest";

import { actor, resource } from "../index.js";
import { createAccessClient } from "./index.js";
import { FakeAuthorization } from "./fake-authorization.js";

describe("createAccessClient", () => {
  const user = actor("user");

  const team = resource("team", {
    roles: {
      admin: user,
      member: user,
    },
    can: ({ admin, member }) => ({
      manage: admin,
      view: [admin, member],
    }),
  });

  const organization = resource("organization", {
    roles: {
      admin: user,
      member: user,
      guest: user.expiring,
      public_viewer: user.anyone,
      team_viewer: team.roles.member,
    },
    can: ({ admin, member, guest, public_viewer, team_viewer }) => ({
      manage: admin,
      view: [admin, member, guest, public_viewer, team_viewer],
    }),
  });

  const task = organization.child("task", {
    inherit: "all",
    roles: {
      assignee: user,
    },
    can: ({ assignee }) => ({
      edit: assignee,
      view: assignee,
    }),
  });

  function createFake(): FakeAuthorization {
    return new FakeAuthorization({
      organization: {
        manage: ["admin"],
        view: ["admin", "member", "guest", "public_viewer", "team_viewer"],
      },
      task: {
        edit: ["assignee"],
        view: ["assignee"],
      },
      team: {
        manage: ["admin"],
        view: ["admin", "member"],
      },
    });
  }

  it("grants, checks, lists, queries subjects, lists direct members, and revokes", async () => {
    const fake = createFake();
    const client = createAccessClient(fake);

    // Denial when no relationship exists.
    expect(await client.can(user("alice"), organization("org-1").view)).toBe(false);
    expect(await client.can(user("alice"), task("task-1").edit)).toBe(false);

    // Grant direct roles and parent link.
    const token = await client.add(user("alice"), organization("org-1").member);
    expect(token).toContain("fake-token-");
    await client.add(user("bob"), organization("org-1").admin);
    await client.add(user("alice"), task("task-1").assignee);
    await client.add(user("alice"), task("task-2").assignee);
    await client.add(organization("org-1"), task("task-1").organization);

    // Positive checks.
    expect(await client.can(user("alice"), organization("org-1").view)).toBe(true);
    expect(await client.can(user("alice"), organization("org-1").manage)).toBe(false);
    expect(await client.can(user("bob"), organization("org-1").manage)).toBe(true);
    expect(await client.can(user("alice"), task("task-1").edit)).toBe(true);
    expect(await client.can(user("bob"), task("task-1").edit)).toBe(false);

    // list() returns authorized resource IDs.
    expect(await client.list(user("alice"), task.can.edit)).toEqual(["task-1", "task-2"]);
    expect(await client.list(user("bob"), task.can.edit)).toEqual([]);

    // whoCan() works with both DslActor and EntityHandle.
    expect(await client.whoCan(organization("org-1").view, user)).toEqual({
      subjects: ["alice", "bob"],
      hasWildcard: false,
    });
    expect(await client.whoCan(organization("org-1").manage, user.handle)).toEqual({
      subjects: ["bob"],
      hasWildcard: false,
    });

    // listDirect() returns direct tuples on a slot (including resource parent links).
    expect(await client.listDirect(task("task-1").organization)).toEqual([{ type: "organization", id: "org-1" }]);
    expect(await client.listDirect(organization("org-1").member)).toEqual([{ type: "user", id: "alice" }]);

    // remove() revokes the specific tuple without removing other roles.
    await client.remove(user("alice"), organization("org-1").member);
    expect(await client.can(user("alice"), organization("org-1").view)).toBe(false);
    expect(await client.can(user("bob"), organization("org-1").view)).toBe(true);
  });

  it("supports expiring grants, wildcard subjects, and userset subjects", async () => {
    let now = new Date("2026-06-01T00:00:00Z");
    const fake = new FakeAuthorization(
      {
        organization: {
          view: ["guest", "public_viewer", "team_viewer"],
        },
      },
      { now: () => now },
    );
    const client = createAccessClient(fake);

    // Expiring grant active before expiresAt, denied after.
    await client.add(user("temp"), organization("org-1").guest, {
      expiresAt: new Date("2026-06-02T00:00:00Z"),
    });
    expect(await client.can(user("temp"), organization("org-1").view)).toBe(true);
    now = new Date("2026-06-03T00:00:00Z");
    expect(await client.can(user("temp"), organization("org-1").view)).toBe(false);

    // Wildcard subject (`user.anyone`) and userset subject (`team(id).member`).
    await client.add(user.anyone, organization("org-2").public_viewer);
    await client.add(team("team-9").member, organization("org-2").team_viewer);

    expect(await client.listDirect(organization("org-2").public_viewer)).toEqual([{ type: "user", id: "*" }]);
    expect(await client.listDirect(organization("org-2").team_viewer)).toEqual([
      { type: "team", id: "team-9", relation: "member" },
    ]);
    expect(await client.whoCan(organization("org-2").view, user)).toEqual({
      subjects: [],
      hasWildcard: true,
    });
  });
});
