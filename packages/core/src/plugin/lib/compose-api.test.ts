import { expect, expectTypeOf, it, vi } from "vitest";

import { composeApi } from "./compose-api.js";
import { definePlugin } from "./define-plugin.js";
import { defineService } from "./define-service.js";
import { providePlugin } from "./provide-plugin.js";

it("projects only explicitly selected runtime surfaces and still disposes setup", async () => {
  const dispose = vi.fn();
  const notices = definePlugin({
    name: "notices",
    setup: ({ scope }) => {
      scope.onDispose(dispose);
      return {
        provides: { count: 1 },
        routes: [{ path: "/notices" }],
        jobs: [{ name: "cleanup", priority: 1 }],
      };
    },
  });
  const data = await composeApi("data", {
    services: [notices],
    routes: [],
    jobs: [],
  }).start();
  const http = await composeApi("http", {
    services: [],
    routes: [notices],
    jobs: [],
  }).start();
  const worker = await composeApi("worker", {
    services: [],
    routes: [],
    jobs: [notices],
  }).start();
  try {
    expect(data.read(notices).count).toBe(1);
    expect(data.routes).toEqual([]);
    expectTypeOf(data.jobs).toEqualTypeOf<readonly never[]>();
    expect(data.jobs).toEqual([]);
    expectTypeOf(http.routes).toEqualTypeOf<readonly { path: string }[]>();
    expect(http.routes).toEqual([{ path: "/notices" }]);
    expectTypeOf(http.jobs).toEqualTypeOf<readonly never[]>();
    expect(http.jobs).toEqual([]);
    expectTypeOf(worker.jobs).toEqualTypeOf<readonly { name: string; priority: number }[]>();
    expect(worker.routes).toEqual([]);
    expect(worker.jobs).toEqual([{ name: "cleanup", priority: 1 }]);
  } finally {
    await Promise.all([data.stop(), http.stop(), worker.stop()]);
  }
  expect(dispose).toHaveBeenCalledTimes(3);
});

it("names the API when two selected plugins implement the same service", () => {
  const clock = defineService("clock").ofType<() => Date>();
  const first = providePlugin("first", clock, () => () => new Date());
  const second = providePlugin("second", clock, () => () => new Date());
  expect(() =>
    composeApi("customer", {
      services: [first, second],
      routes: [],
      jobs: [],
    }),
  ).toThrow("API customer: service clock is implemented by both first and second");
});

it("exposes both routes and jobs when the same plugin is selected in both slots", async () => {
  const startCount = vi.fn();
  const billing = definePlugin({
    name: "billing",
    setup: () => {
      startCount();
      return {
        routes: [{ path: "/billing" }],
        jobs: [{ name: "reconcile" }],
      };
    },
  });
  const combined = await composeApi("combined", {
    services: [],
    routes: [billing],
    jobs: [billing],
  }).start();
  try {
    expect(startCount).toHaveBeenCalledTimes(1);
    expect(combined.routes).toEqual([{ path: "/billing" }]);
    expect(combined.jobs).toEqual([{ name: "reconcile" }]);
  } finally {
    await combined.stop();
  }
});

it("infers Provides from implements on definePlugin without explicit generics", async () => {
  type Mailer = { readonly send: (to: string) => string };
  const configService = defineService("config").ofType<{ readonly prefix: string }>();
  const mailerService = defineService("mailer").ofType<Mailer>();

  const configPlugin = providePlugin("config", configService, () => ({ prefix: "hi:" }));
  const mailPlugin = definePlugin({
    name: "mail",
    requires: [configService],
    implements: mailerService,
    setup: ({ use }) => {
      const { prefix } = use(configService);
      return {
        provides: { send: (to) => `${prefix}${to}` },
      };
    },
  });

  const started = await composeApi("mail-api", {
    services: [configPlugin, mailPlugin],
    routes: [],
    jobs: [],
  }).start();
  try {
    expect(started.read(mailerService).send("ada")).toBe("hi:ada");
  } finally {
    await started.stop();
  }
});
