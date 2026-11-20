/**
 * What/why: the guard is what keeps a list from silently growing until it
 * fails. Each threshold is pinned with the fake client and the real tally: a
 * lookup on a record is refused unless it is a sparse direct grant or a dated
 * exception, a lookup past the warning mark succeeds and notes a fault, one
 * past the hard cap fails naming the type, and a request past the round-trip
 * budget notes a fault. None of it trusts the declared kind for the sizes.
 */
import { describe, expect, it } from "vitest";

import { measureWork } from "@dads-framework/request-work";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { relationshipWrite } from "@dads-framework/access/runtime";
import {
  GuardedAuthorization,
  LookupOverHardCapError,
  RecordLookupRefusedError,
  type EntityKindLookup,
} from "./guarded-authorization.js";
import { TalliedAuthorization } from "./tallied-authorization.js";

const user = { type: "user", id: "user-1" };

const kinds: EntityKindLookup = {
  kindOf: (resourceType) =>
    (
      ({
        "test/site": "scope",
        "test/machine": "catalog",
        "test/ticket": "record",
        "test/legacy-ticket": "record",
      }) as const
    )[resourceType],
  mayLookupRecord: (resourceType, permission) =>
    (resourceType === "test/ticket" && permission === "assignee") ||
    resourceType === "test/legacy-ticket",
};

const marks = { warnLookupIds: 3, maxLookupIds: 6, warnRoundTrips: 4 };

/** A fake holding `count` machines the user may view, guarded and tallied. */
function guardedWith(count: number) {
  const fake = new FakeAuthorization({
    "test/machine": { view: ["viewer"] },
    "test/site": { view: ["viewer"] },
    "test/ticket": { view: ["viewer"], assignee: ["assignee"] },
    "test/legacy-ticket": { view: ["viewer"] },
  });
  for (let index = 0; index < count; index += 1) {
    fake.seed(
      relationshipWrite(
        { type: "test/machine", id: `m-${index}` },
        "viewer",
        user,
      ),
    );
  }
  return new GuardedAuthorization(new TalliedAuthorization(fake), marks, kinds);
}

const machines = {
  subject: user,
  resourceType: "test/machine",
  permission: "view",
};

describe("GuardedAuthorization record lookups", () => {
  it("refuses a lookup on a record, pointing at requiresScoped", async () => {
    await expect(
      guardedWith(0).lookupResources({
        subject: user,
        resourceType: "test/ticket",
        permission: "view",
      }),
    ).rejects.toThrow(RecordLookupRefusedError);
    await expect(
      guardedWith(0).lookupResources({
        subject: user,
        resourceType: "test/ticket",
        permission: "view",
      }),
    ).rejects.toThrow(
      "lookupResources on test/ticket#view refused: test/ticket is a record, and a record list must use requiresScoped",
    );
  });

  it("lets a sparse direct grant and a dated exception through", async () => {
    const guarded = guardedWith(0);
    await expect(
      guarded.lookupResources({
        subject: user,
        resourceType: "test/ticket",
        permission: "assignee",
      }),
    ).resolves.toEqual([]);
    await expect(
      guarded.lookupResources({
        subject: user,
        resourceType: "test/legacy-ticket",
        permission: "view",
      }),
    ).resolves.toEqual([]);
  });

  it("leaves scope and catalog lookups alone", async () => {
    const guarded = guardedWith(2);
    await expect(guarded.lookupResources(machines)).resolves.toHaveLength(2);
    await expect(
      guarded.lookupResources({
        subject: user,
        resourceType: "test/site",
        permission: "view",
      }),
    ).resolves.toEqual([]);
  });
});

describe("GuardedAuthorization size marks", () => {
  it("keeps the largest lookup on the request and notes nothing at the mark", async () => {
    const { tally } = await measureWork(() =>
      guardedWith(3).lookupResources(machines),
    );
    expect(tally.authzLargestLookupCount).toBe(3);
    expect(tally.authzWarning).toBeUndefined();
  });

  it("succeeds past the warning mark and notes a fault naming type, permission and count", async () => {
    const { result, tally } = await measureWork(() =>
      guardedWith(4).lookupResources(machines),
    );
    expect(result).toHaveLength(4);
    expect(tally.authzLargestLookupCount).toBe(4);
    expect(tally.authzWarning).toEqual({
      type: "AuthorizationLookupOverWarningMark",
      fingerprint: "authz.lookup-size:test/machine#view",
      detail:
        "lookupResources on test/machine#view for a user returned 4 ids, over the 3 mark (AUTHZ_LOOKUP_WARN_IDS)",
    });
  });

  it("fails past the hard cap, naming the resource type, whatever its declared kind", async () => {
    const { result } = await measureWork(async () => {
      try {
        await guardedWith(7).lookupResources(machines);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(result).toBeInstanceOf(LookupOverHardCapError);
    expect(result).toHaveProperty(
      "message",
      "lookupResources on test/machine#view for a user returned 7 ids, over the 6 cap (AUTHZ_LOOKUP_MAX_IDS); this list must be filtered by scope, not by every visible id",
    );
  });

  it("refuses marks that are out of order or past Postgres's parameter limit", () => {
    const fake = new FakeAuthorization();
    expect(
      () =>
        new GuardedAuthorization(fake, { ...marks, warnLookupIds: 6 }, kinds),
    ).toThrow("must be below maxLookupIds");
    expect(
      () =>
        new GuardedAuthorization(
          fake,
          { ...marks, maxLookupIds: 70_000 },
          kinds,
        ),
    ).toThrow("must stay below Postgres's 65535-parameter limit");
    expect(
      () =>
        new GuardedAuthorization(fake, { ...marks, warnRoundTrips: 0 }, kinds),
    ).toThrow("warnRoundTrips must be a positive integer");
  });
});

describe("GuardedAuthorization round-trip budget", () => {
  const permission = {
    subject: user,
    permission: "view",
    resource: { type: "test/machine", id: "m-0" },
  };

  it("notes nothing within the budget", async () => {
    const guarded = guardedWith(1);
    const { tally } = await measureWork(async () => {
      for (let call = 0; call < 4; call += 1) await guarded.check(permission);
    });
    expect(tally.authzCheckCount).toBe(4);
    expect(tally.authzWarning).toBeUndefined();
  });

  it("notes a fault once a request's round trips pass the budget", async () => {
    const guarded = guardedWith(1);
    const { tally } = await measureWork(async () => {
      for (let call = 0; call < 5; call += 1) await guarded.check(permission);
    });
    expect(tally.authzCheckCount).toBe(5);
    expect(tally.authzWarning).toEqual({
      type: "AuthorizationRoundTripsOverBudget",
      fingerprint: "authz.round-trips",
      detail:
        "request made more than 4 authorization round trips (AUTHZ_ROUND_TRIPS_WARN)",
    });
  });
});
