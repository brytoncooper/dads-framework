import { describe, expect, it } from "vitest";
import { RecordingAuthorization } from "@dads-framework/access/testing";

/** What: decision fake returns only configured answers. Why: unit tests must not pretend to execute SpiceDB arrows. */
describe("RecordingAuthorization", () => {
  it("records exact configured check and lookup questions", async () => {
    const check = {
      subject: { type: "user", id: "opal" },
      resource: { type: "platform", id: "app" },
      permission: "view",
    };
    const lookup = {
      subject: { type: "user", id: "opal" },
      resourceType: "platform",
      permission: "view",
    };
    const fake = new RecordingAuthorization({
      checks: [{ query: check, answer: true }],
      lookups: [{ query: lookup, answer: ["app"] }],
    });

    await expect(fake.check(check)).resolves.toBe(true);
    await expect(fake.lookupResources(lookup)).resolves.toEqual(["app"]);
    expect(fake.questions).toEqual([
      { kind: "check", query: check },
      { kind: "lookup", query: lookup },
    ]);
  });

  it("matches and records a lookup when named query fields are reordered", async () => {
    const configured = {
      subject: { type: "user", id: "opal" },
      resourceType: "platform",
      permission: "view",
    };
    const query = {
      permission: "view",
      resourceType: "platform",
      subject: { id: "opal", type: "user" },
    };
    const fake = new RecordingAuthorization({
      lookups: [{ query: configured, answer: ["app"] }],
    });

    await expect(fake.lookupResources(query)).resolves.toEqual(["app"]);
    expect(fake.questions).toEqual([{ kind: "lookup", query }]);
  });

  it("fails loudly rather than inferring an unanswered decision or accepting tuple mutation", async () => {
    const fake = new RecordingAuthorization();
    await expect(
      fake.check({
        subject: { type: "user", id: "opal" },
        resource: { type: "platform", id: "app" },
        permission: "view",
      }),
    ).rejects.toThrow("unanswered check");
    await expect(fake.writeRelationships([])).rejects.toThrow(
      "does not support tuple mutation",
    );
    await expect(
      fake.lookupResources({
        subject: { id: "opal", type: "user" },
        resourceType: "platform",
        permission: "view",
      }),
    ).rejects.toThrow("unanswered lookup");
    await expect(
      fake.deleteRelationships({ resourceType: "platform" }),
    ).rejects.toThrow("does not support tuple mutation");
    await expect(
      fake.relationshipExists({
        resourceType: "platform",
        resourceId: "app",
        relation: "admin",
      }),
    ).rejects.toThrow("does not support tuple inspection");
    await expect(
      fake.listDirectSubjects({
        resource: { type: "platform", id: "app" },
        relation: "admin",
      }),
    ).rejects.toThrow("does not support tuple inspection");
  });

  it("keys answers by named fields rather than object insertion order and rejects duplicates", async () => {
    const query = {
      subject: { type: "user", id: "opal" },
      resource: { type: "platform", id: "app" },
      permission: "view",
    };
    const fake = new RecordingAuthorization({
      checks: [{ query, answer: true }],
    });
    await expect(
      fake.check({
        permission: "view",
        resource: { id: "app", type: "platform" },
        subject: { id: "opal", type: "user" },
      }),
    ).resolves.toBe(true);
    expect(
      () =>
        new RecordingAuthorization({
          checks: [
            { query, answer: true },
            { query, answer: false },
          ],
        }),
    ).toThrow("duplicate check answer");
  });

  it("records an unanswered check before rejecting it", async () => {
    const fake = new RecordingAuthorization();
    const query = {
      subject: { type: "user", id: "opal" },
      resource: { type: "platform", id: "app" },
      permission: "view",
    };
    await expect(fake.check(query)).rejects.toThrow("unanswered check");
    expect(fake.questions).toEqual([{ kind: "check", query }]);
  });

  it("rejects duplicate lookup answers", () => {
    const query = {
      subject: { type: "user", id: "opal" },
      resourceType: "platform",
      permission: "view",
    };
    expect(
      () =>
        new RecordingAuthorization({
          lookups: [
            { query, answer: [] },
            { query, answer: ["app"] },
          ],
        }),
    ).toThrow("duplicate lookup answer");
  });

  it("gives exact guidance for all unsupported interface methods", async () => {
    const fake = new RecordingAuthorization();
    const unsupportedMethods: readonly {
      call: () => Promise<unknown>;
      message: string;
    }[] = [
      {
        call: () => fake.writeRelationships([]),
        message:
          "RecordingAuthorization does not support tuple mutation; use FakeAuthorization",
      },
      {
        call: () => fake.deleteRelationships({ resourceType: "platform" }),
        message:
          "RecordingAuthorization does not support tuple mutation; use FakeAuthorization",
      },
      {
        call: () =>
          fake.relationshipExists({
            resourceType: "platform",
            resourceId: "app",
            relation: "admin",
          }),
        message:
          "RecordingAuthorization does not support tuple inspection; use FakeAuthorization",
      },
      {
        call: () =>
          fake.listDirectSubjects({
            resource: { type: "platform", id: "app" },
            relation: "admin",
          }),
        message:
          "RecordingAuthorization does not support tuple inspection; use FakeAuthorization",
      },
    ];

    for (const method of unsupportedMethods) {
      let rejection: unknown;
      try {
        await method.call();
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      if (rejection instanceof Error)
        expect(rejection.message).toBe(method.message);
    }
  });
});
