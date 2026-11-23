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
