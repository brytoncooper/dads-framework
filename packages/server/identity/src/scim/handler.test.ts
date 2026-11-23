import { randomUUID } from "node:crypto";
import type { ScimDirectory, ScimUser } from "./index.js";
import { describe, expect, it } from "vitest";
import { createScimHandler, matchesScimUserFilter } from "./index.js";
import { patchSchema, userSchema } from "./protocol.js";

function testDirectory(): ScimDirectory {
  const tenants = new Map<string, Map<string, ScimUser>>();
  function tenant(tenantId: string): Map<string, ScimUser> {
    const users = tenants.get(tenantId) ?? new Map<string, ScimUser>();
    tenants.set(tenantId, users);
    return users;
  }

  return {
    list(tenantId, { filter, startIndex, count }) {
      const matches = [...tenant(tenantId).values()].filter((user) => !filter || matchesScimUserFilter(user, filter));
      return Promise.resolve({
        totalResults: matches.length,
        users: matches.slice(startIndex - 1, startIndex - 1 + count),
      });
    },
    get: (tenantId, id) => Promise.resolve(tenant(tenantId).get(id) ?? null),
    create(tenantId, data) {
      const users = tenant(tenantId);
      if ([...users.values()].some((user) => user.userName.toLowerCase() === data.userName.toLowerCase())) {
        return Promise.resolve("conflict");
      }
      const time = new Date().toISOString();
      const user = {
        ...data,
        id: randomUUID(),
        created: time,
        lastModified: time,
      };
      users.set(user.id, user);
      return Promise.resolve(user);
    },
    update(tenantId, id, change) {
      const users = tenant(tenantId);
      const current = users.get(id);
      if (!current) return Promise.resolve(null);
      const data = change(current);
      if (
        [...users.values()].some(
          (user) => user.id !== id && user.userName.toLowerCase() === data.userName.toLowerCase(),
        )
      ) {
        return Promise.resolve("conflict");
      }
      const user = {
        ...data,
        id,
        created: current.created,
        lastModified: new Date().toISOString(),
      };
      users.set(id, user);
      return Promise.resolve(user);
    },
    delete: (tenantId, id) => Promise.resolve(tenant(tenantId).delete(id)),
  };
}

const baseUrl = "https://provision.example.test/scim/v2";
const createUser = (userName: string) => ({
  schemas: [userSchema],
  userName,
  externalId: "idp-record",
  name: { givenName: "Sam", familyName: "Quinn" },
  emails: [{ value: "sam@example.test", type: "work" }],
});

function setup() {
  const handler = createScimHandler({
    baseUrl,
    authenticate: (token) => Promise.resolve(token === "alpha" || token === "beta" ? token : null),
    directory: testDirectory(),
  });
  return (path: string, method = "GET", body?: unknown, authorization = "Bearer alpha") =>
    handler(
      new Request(`${baseUrl}/${path}`, {
        method,
        headers: {
          authorization,
          "Content-Type": "application/scim+json",
          "X-Tenant-ID": "alpha",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

function createdPath(response: Response): string {
  const location = response.headers.get("Location");
  if (!location?.startsWith(`${baseUrl}/Users/`)) throw new Error("Missing canonical User location.");
  return location.slice(baseUrl.length + 1);
}

describe("tenant-bound SCIM HTTP", () => {
  it("publishes configuration and the supported User schema and resource type", async () => {
    const send = setup();
    const config = await send("ServiceProviderConfig");
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toMatchObject({
      patch: { supported: true },
      filter: { supported: true, maxResults: 100 },
      bulk: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
    });
    const types = await send("ResourceTypes");
    await expect(types.json()).resolves.toMatchObject({
      totalResults: 1,
      Resources: [{ endpoint: "/Users" }],
    });
    const schema = await send(`Schemas/${encodeURIComponent(userSchema)}`);
    await expect(schema.json()).resolves.toMatchObject({
      id: userSchema,
      name: "User",
    });
    expect((await send("Groups")).status).toBe(404);
  });

  it.each([
    ["ServiceProviderConfig", "GET"],
    ["Users", "GET"],
    ["Users", "POST"],
    ["Users/id", "GET"],
    ["Users/id", "PUT"],
    ["Users/id", "PATCH"],
    ["Users/id", "DELETE"],
  ])("requires a valid bearer credential for %s %s", async (path, method) => {
    const send = setup();
    for (const authorization of ["", "Basic alpha", "Bearer forged"]) {
      const denied = await send(path, method, undefined, authorization);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("WWW-Authenticate")).toBe("Bearer");
      await expect(denied.json()).resolves.toMatchObject({ status: "401" });
    }
  });

  it("creates users and preserves the server ID through replacement and deactivation", async () => {
    const send = setup();
    const created = await send("Users", "POST", {
      ...createUser("Sam"),
      id: "client-supplied",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toBe("application/scim+json");
    const path = createdPath(created);
    const id = path.slice("Users/".length);
    expect(id).not.toBe("client-supplied");
    await expect(created.json()).resolves.toMatchObject({
      id,
      userName: "Sam",
      active: true,
    });
    const replacement = await send(path, "PUT", {
      schemas: [userSchema],
      userName: "sam.quinn",
      active: true,
    });
    expect(replacement.status).toBe(200);
    await expect(replacement.json()).resolves.toMatchObject({
      id,
      userName: "sam.quinn",
      active: true,
    });
    const patch = await send(path, "PATCH", {
      schemas: [patchSchema],
      Operations: [
        { op: "Replace", value: { active: false } },
        { op: "add", path: "name.givenName", value: "Sam" },
      ],
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      id,
      active: false,
      name: { givenName: "Sam" },
    });
    const lookup = await send(path);
    await expect(lookup.json()).resolves.not.toHaveProperty("externalId");
    expect((await send(path, "DELETE")).status).toBe(204);
    expect((await send(path)).status).toBe(404);
    expect((await send(path, "DELETE")).status).toBe(404);
  });

  it("scopes uniqueness, filtering, counts, and every resource mutation to the credential tenant", async () => {
    const send = setup();
    const existing = await send("Users", "POST", createUser("sam"));
    const path = createdPath(existing);
    expect((await send("Users", "POST", createUser("SAM"))).status).toBe(409);
    const beta = "Bearer beta";
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", createUser("sam-copy")],
      [
        "PATCH",
        {
          schemas: [patchSchema],
          Operations: [{ op: "replace", path: "active", value: false }],
        },
      ],
      ["DELETE", undefined],
    ] satisfies [string, unknown][]) {
      expect((await send(path, method, body, beta)).status).toBe(404);
    }
    const filter = encodeURIComponent('userName eq "SAM"');
    const empty = await send(`Users?filter=${filter}`, "GET", undefined, beta);
    await expect(empty.json()).resolves.toMatchObject({
      totalResults: 0,
      Resources: [],
    });
    const peer = await send("Users", "POST", createUser("SAM"), beta);
    expect(peer.status).toBe(201);
    expect(createdPath(peer)).not.toBe(path);
    const original = await send(path);
    await expect(original.json()).resolves.toMatchObject({
      userName: "sam",
      active: true,
    });
    const countOnly = await send(`Users?filter=${filter}&count=0`);
    await expect(countOnly.json()).resolves.toMatchObject({
      totalResults: 1,
      itemsPerPage: 0,
      Resources: [],
    });
    const filtered = await send(`Users?filter=${filter}&attributes=userName,name.givenName`);
    await expect(filtered.json()).resolves.toMatchObject({
      totalResults: 1,
      Resources: [{ userName: "sam", name: { givenName: "Sam" } }],
    });
  });

  it("rolls back a multi-operation patch when a later path fails", async () => {
    const send = setup();
    const created = await send("Users", "POST", createUser("sam"));
    const path = createdPath(created);
    const failed = await send(path, "PATCH", {
      schemas: [patchSchema],
      Operations: [
        { op: "replace", path: "active", value: false },
        { op: "remove", path: "userName" },
      ],
    });
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toMatchObject({
      scimType: "mutability",
    });
    const original = await send(path);
    await expect(original.json()).resolves.toMatchObject({
      userName: "sam",
      active: true,
    });
  });
  it("rejects unsupported filters instead of listing all users", async () => {
    const send = setup();
    const response = await send(`Users?filter=${encodeURIComponent('userName co "sam"')}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      scimType: "invalidFilter",
    });
  });

  it("rejects an invalid operation even when a later operation replaces its target", async () => {
    const send = setup();
    const created = await send("Users", "POST", createUser("sam"));
    const path = createdPath(created);
    const failed = await send(path, "PATCH", {
      schemas: [patchSchema],
      Operations: [
        { op: "replace", path: "active", value: "false" },
        { op: "replace", path: "active", value: false },
      ],
    });
    expect(failed.status).toBe(400);
    const original = await send(path);
    await expect(original.json()).resolves.toMatchObject({ active: true });
  });
  it("rejects a body over the SCIM request size limit", async () => {
    const send = setup();
    const response = await send("Users", "POST", createUser("x".repeat(64 * 1024)));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ status: "413" });
  });
});
