import { join } from "node:path";

import { accessModel, emitAccessIr } from "@dads-framework/access";
import { FakeAuthorization } from "@dads-framework/authorization/testing";
import {
  buildTestApp,
  TEST_SUBJECT_HEADER,
} from "@dads-framework/http/testing";
import { discoverDomainMigrations } from "@dads-framework/migrations";
import {
  composeApi,
  definePlugin,
  providePlugin,
} from "@dads-framework/plugin";
import { expect, expectTypeOf, it, vi } from "vitest";

import { clockService } from "../clock-service.js";
import { noteEntity } from "../notes-access.js";
import { notesData } from "../notes-data.js";
import { customerNotes } from "../surfaces/customer-notes.js";
import { staffDashboard, staffNotes } from "../surfaces/staff-notes.js";
import { customerApi } from "./customer-api.js";
import { apiClock } from "./host-clock.js";
import { staffApi } from "./staff-api.js";

it("keeps staff routes and jobs out of the customer API, even for a staff identity", async () => {
  const customer = await customerApi.start();
  const staff = await staffApi.start();
  const authorization = new FakeAuthorization({
    [noteEntity.wireName]: { view: ["author"] },
    [staffDashboard.wireName]: { inspect: ["operator"] },
  });
  const staffHeaders = { [TEST_SUBJECT_HEADER]: "staff-operator" };
  customer.read(notesData).write("note-one", "one note");
  authorization.seed({
    resource: { type: noteEntity.wireName, id: "note-one" },
    relation: "author",
    subject: { type: "user", id: staffHeaders[TEST_SUBJECT_HEADER] },
  });
  authorization.seed({
    resource: { type: staffDashboard.wireName, id: "notes" },
    relation: "operator",
    subject: { type: "user", id: staffHeaders[TEST_SUBJECT_HEADER] },
  });
  const customerHttp = await buildTestApp({
    routes: customer.routes,
    authorization,
  });
  const staffHttp = await buildTestApp({ routes: staff.routes, authorization });

  try {
    const request = {
      method: "GET" as const,
      url: "/staff/notes/count",
      headers: staffHeaders,
    };
    expect((await staffHttp.inject(request)).statusCode).toBe(200);
    expect((await customerHttp.inject(request)).statusCode).toBe(404);
    expect(
      (
        await staffHttp.inject({
          ...request,
          headers: { [TEST_SUBJECT_HEADER]: "customer" },
        })
      ).statusCode,
    ).toBe(404);
    const customerRequest = { ...request, url: "/notes/note-one" };
    expect((await customerHttp.inject(customerRequest)).statusCode).toBe(200);
    expect((await staffHttp.inject(customerRequest)).statusCode).toBe(404);
    expect(customer.jobs).toEqual([]);
    expect(staff.jobs.map((job) => job.name)).toEqual(["notes.count"]);
  } finally {
    await Promise.all([
      customerHttp.close(),
      staffHttp.close(),
      customer.stop(),
      staff.stop(),
    ]);
  }
});

it("reads only selected access and migrations before any service starts", async () => {
  const setup = vi.fn(() => ({ now: () => new Date() }));
  const offlineClock = providePlugin("offline-clock", clockService, setup);
  const offlineApi = composeApi("customer", {
    services: [offlineClock, notesData],
    routes: [customerNotes],
    jobs: [],
  });
  expectTypeOf(offlineApi.name).toEqualTypeOf<"customer">();
  const root = join(import.meta.dirname, "..", "..", "..", "..");
  const migrations = await discoverDomainMigrations({
    workspace: {
      root,
      sources: offlineApi.migrationSources(root),
      moduleAliases: {},
    },
  });
  expect(migrations.map(({ owner }) => owner)).toEqual(["notes-data"]);
  expect(
    emitAccessIr(accessModel(offlineApi.access)).map(
      ({ wireName }) => wireName,
    ),
  ).toEqual(["notes_user", "notes/note"]);
  expect(
    emitAccessIr(accessModel(staffApi.access)).map(({ wireName }) => wireName),
  ).toContain(staffDashboard.wireName);
  expect(setup).not.toHaveBeenCalled();

  const servicesOnly = await composeApi("worker", {
    services: [apiClock, notesData],
    routes: [],
    jobs: [],
  }).start();
  try {
    expect(servicesOnly.routes).toEqual([]);
    expect(servicesOnly.jobs).toEqual([]);
  } finally {
    await servicesOnly.stop();
  }
});

it("names the API, selected contribution, and missing dependency", () => {
  const otherNotes = definePlugin({ name: "notes-data" });
  expect(() =>
    composeApi("staff", {
      services: [apiClock, otherNotes],
      routes: [staffNotes],
      jobs: [],
    }),
  ).toThrow(/API staff: plugin staff-notes requires plugin notes-data/);
});
