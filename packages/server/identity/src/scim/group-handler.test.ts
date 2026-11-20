import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createScimHandler } from "./index.js";
import type { ScimGroup, ScimGroupData, ScimGroupDirectory } from "./index.js";
import { groupSchema, patchSchema } from "./protocol.js";

const baseUrl = "https://provision.example.test/scim/v2";
const memberA = "User-A";
const memberB = "User-B";
const foreignMember = "User-Beta";

function groupDirectory(): ScimGroupDirectory {
  const groups = new Map<string, Map<string, ScimGroup>>();
  const memberIds = new Map([
    ["alpha", [memberA, memberB]],
    ["beta", [foreignMember]],
  ]);

  function scoped(tenant: string): Map<string, ScimGroup> {
    const storage = groups.get(tenant) ?? new Map<string, ScimGroup>();
    groups.set(tenant, storage);
    return storage;
  }

  function save(
    tenant: string,
    data: ScimGroupData,
    id: string = randomUUID(),
    created = new Date().toISOString(),
  ) {
    const allowed = memberIds.get(tenant) ?? [];
    if (data.members.some((member) => !allowed.includes(member.value)))
      return "invalidMember";
    const group = {
      ...data,
      id,
      created,
      lastModified: new Date().toISOString(),
    };
    scoped(tenant).set(id, group);
    return group;
  }

  return {
    list(tenant, { filter, count, startIndex }) {
      const matches = [...scoped(tenant).values()].filter((group) => {
        if (!filter) return true;
        if (filter.attribute === "displayName")
          return group.displayName.toLowerCase() === filter.value.toLowerCase();
        return group[filter.attribute] === filter.value;
      });
      return Promise.resolve({
        groups: matches.slice(startIndex - 1, startIndex + count - 1),
        totalResults: matches.length,
      });
    },
    get: (tenant, id) => Promise.resolve(scoped(tenant).get(id) ?? null),
    create: (tenant, data) => Promise.resolve(save(tenant, data)),
    update(tenant, id, change) {
      const current = scoped(tenant).get(id);
      return Promise.resolve(
        current
          ? save(tenant, change(current), current.id, current.created)
          : null,
      );
    },
    delete: (tenant, id) => Promise.resolve(scoped(tenant).delete(id)),
  };
}

function setup() {
  const handler = createScimHandler({
    baseUrl,
    authenticate: (token) =>
      Promise.resolve(["alpha", "beta"].includes(token) ? token : null),
    directory: {
      list: () => Promise.resolve({ users: [], totalResults: 0 }),
      get: () => Promise.resolve(null),
      create: () => Promise.resolve("conflict"),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(false),
    },
    groups: groupDirectory(),
  });
  return (path: string, method = "GET", data?: unknown, token = "alpha") =>
    handler(
      new Request(`${baseUrl}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/scim+json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
    );
}

function groupPayload(displayName: string, ...members: string[]) {
  return {
    schemas: [groupSchema],
    displayName,
    members: members.map((value) => ({ value })),
  };
}

function groupPath(response: Response): string {
  const location = response.headers.get("Location");
  if (!location?.startsWith(`${baseUrl}/Groups/`))
    throw new Error("Missing SCIM Group location.");
  return location.slice(baseUrl.length + 1);
}

function patch(...operations: readonly unknown[]) {
  return { schemas: [patchSchema], Operations: operations };
}

describe("optional SCIM Groups", () => {
  it("advertises registered group routes and group schema", async () => {
    const send = setup();
    await expect((await send("ResourceTypes")).json()).resolves.toMatchObject({
      totalResults: 2,
      Resources: [{ endpoint: "/Users" }, { endpoint: "/Groups" }],
    });
    await expect(
      (await send("ResourceTypes/Group")).json(),
    ).resolves.toMatchObject({ id: "Group", schema: groupSchema });
    await expect(
      (await send(`Schemas/${groupSchema}`)).json(),
    ).resolves.toMatchObject({ id: groupSchema, name: "Group" });
  });

  it("creates, filters, replaces, and deletes a group", async () => {
    const send = setup();
    const created = await send(
      "Groups",
      "POST",
      groupPayload("Engineering", memberA),
    );
    expect(created.status).toBe(201);
    const path = groupPath(created);
    const filtered = await send(
      `Groups?filter=${encodeURIComponent('displayName eq "ENGINEERING"')}&attributes=displayName`,
    );
    await expect(filtered.json()).resolves.toMatchObject({
      totalResults: 1,
      Resources: [{ displayName: "Engineering" }],
    });
    const replaced = await send(path, "PUT", groupPayload("Platform", memberB));
    await expect(replaced.json()).resolves.toMatchObject({
      displayName: "Platform",
      members: [
        { value: memberB, type: "User", $ref: `${baseUrl}/Users/${memberB}` },
      ],
    });
    expect((await send(path, "DELETE")).status).toBe(204);
    expect((await send(path)).status).toBe(404);
  });

  it("adds, removes, and replaces Group members using IdP PATCH formats", async () => {
    const send = setup();
    const path = groupPath(
      await send("Groups", "POST", groupPayload("Engineering", memberA)),
    );
    const added = await send(
      path,
      "PATCH",
      patch(
        {
          op: "Add",
          path: "members",
          value: [{ value: memberA }, { value: memberB }],
        },
        { op: "Remove", path: `members[value eq "${memberA}"]` },
      ),
    );
    await expect(added.json()).resolves.toMatchObject({
      members: [{ value: memberB }],
    });
    const replaced = await send(
      path,
      "PATCH",
      patch(
        { op: "Replace", value: { members: [{ value: memberA }] } },
        { op: "remove", path: "members", value: [{ value: memberA }] },
      ),
    );
    await expect(replaced.json()).resolves.toMatchObject({ members: [] });
  });

  it("denies cross-tenant access, foreign members, and unauthenticated Group operations", async () => {
    const send = setup();
    const data = groupPayload("Engineering", memberA);
    const path = groupPath(await send("Groups", "POST", data));
    expect(
      (await send("Groups", "POST", groupPayload("Beta", foreignMember)))
        .status,
    ).toBe(400);
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", data],
      ["PATCH", patch({ op: "remove", path: "members" })],
      ["DELETE", undefined],
    ] satisfies [string, unknown][]) {
      expect((await send(path, method, body, "beta")).status).toBe(404);
      expect((await send(path, method, body, "forged")).status).toBe(401);
    }
    await expect(
      (await send("Groups", "GET", undefined, "beta")).json(),
    ).resolves.toMatchObject({ totalResults: 0 });
    const invalid = await send(
      path,
      "PATCH",
      patch(
        { op: "replace", path: "displayName", value: "Changed" },
        { op: "add", path: "members", value: [{ value: foreignMember }] },
      ),
    );
    expect(invalid.status).toBe(400);
    await expect((await send(path)).json()).resolves.toMatchObject({
      displayName: "Engineering",
      members: [{ value: memberA }],
    });
  });
  it("requires authentication for Group collections and bounds membership payloads", async () => {
    const send = setup();
    expect((await send("Groups", "GET", undefined, "forged")).status).toBe(401);
    expect(
      (await send("Groups", "POST", groupPayload("Engineering"), "forged"))
        .status,
    ).toBe(401);
    const payload = groupPayload(
      "Engineering",
      ...Array.from({ length: 1001 }, () => memberA),
    );
    const oversized = await send("Groups", "POST", payload);
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({
      scimType: "invalidValue",
    });
  });
});
