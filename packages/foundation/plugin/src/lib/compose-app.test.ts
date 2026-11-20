/**
 * What: composeApp orders a plugin list, refuses what cannot form one app,
 * and starts and stops plugins as one group.
 * Why: the host wires one composed value; every refusal must name the plugin.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { composeApp, type DependencyCheck } from "./compose-app.js";
import { definePlugin } from "./define-plugin.js";
import { defineService } from "./define-service.js";
import type { Dependency } from "./dependency.js";
import { orderPlugins } from "./order-plugins.js";
import {
  PluginCompositionError,
  PluginStartError,
  PluginStopError,
} from "./plugin-errors.js";
import { providePlugin } from "./provide-plugin.js";

type Clock = { readonly now: () => number };
const clockService = defineService("clock").ofType<Clock>();
const fixedClock = providePlugin("fixed-clock", clockService, () => ({
  now: () => 42,
}));

const accounts = definePlugin({
  name: "accounts",
  setup: () => ({ provides: { find: (id: string) => `account ${id}` } }),
});

const notes = definePlugin({
  name: "notes",
  requires: [accounts, clockService],
  contributes: { flags: [{ slug: "notes.sharing", owner: "notes team" }] },
  setup: ({ use }) => ({
    routes: [{ method: "GET", path: "/notes" }],
    jobs: [{ name: "notes.prune", stampedAt: use(clockService).now() }],
    provides: { owner: use(accounts).find("u1") },
  }),
});

describe("composeApp: ordering and refusals", () => {
  it("sets up each plugin after what it requires, otherwise in listed order", () => {
    const app = composeApp([notes, fixedClock, accounts]);
    expect(app.plugins).toEqual(["fixed-clock", "accounts", "notes"]);
  });

  it("refuses a plugin whose dependency is missing, naming both", () => {
    expect(() => orderPlugins([notes, fixedClock])).toThrow(
      "plugin notes requires plugin accounts",
    );
    expect(() => orderPlugins([notes, accounts])).toThrow(
      "plugin notes requires service clock, which no plugin in the composition implements",
    );
  });

  it("refuses a dependency cycle formed through a service", () => {
    const ticketsService = defineService("tickets").ofType<string>();
    const first = definePlugin({
      name: "first",
      requires: [ticketsService],
    });
    const second = definePlugin({
      name: "second",
      requires: [first],
      implements: ticketsService,
      setup: () => ({ provides: "tickets" }),
    });
    expect(() => composeApp([first, second])).toThrow(
      "plugins first, second require each other in a cycle",
    );
  });

  it("refuses a repeated plugin and a service implemented twice", () => {
    const otherClock = providePlugin("other-clock", clockService, () => ({
      now: () => 1,
    }));
    expect(() => composeApp([accounts, accounts])).toThrow(
      "plugin accounts is listed more than once",
    );
    expect(() => composeApp([fixedClock, otherClock])).toThrow(
      "service clock is implemented by both fixed-clock and other-clock",
    );
  });

  it("refuses two plugins claiming one flag, access entity, or audit table", () => {
    const flagged = (name: string) =>
      definePlugin({
        name,
        contributes: {
          flags: [{ slug: "shared.flag" }],
          access: [{ entity: { wireName: `${name}/thing` } }],
        },
      });
    expect(() => composeApp([flagged("one"), flagged("two")])).toThrow(
      "feature flag shared.flag is contributed by both one and two",
    );
    const audited = (name: string) =>
      definePlugin({
        name,
        contributes: { audit: { untrackedTables: ["log"] } },
      });
    expect(() => composeApp([audited("one"), audited("two")])).toThrow(
      PluginCompositionError,
    );
  });

  it("refuses a plugin name that is not lowercase words and dashes", () => {
    expect(() => definePlugin({ name: "Notes Plugin" })).toThrow(
      "must be lowercase words joined by dashes",
    );
  });
});

describe("composeApp: declared contributions", () => {
  it("collects flags, access, and audit tables without starting anything", () => {
    const setup = vi.fn(() => ({}));
    const audit = definePlugin({
      name: "audit",
      contributes: {
        access: [{ entity: { wireName: "audit/log" } }],
        audit: {
          untrackedTables: ["request_log"],
          scopes: [{ table: "note", columns: { workspace: "workspace_id" } }],
        },
      },
      setup,
    });
    const app = composeApp([audit, fixedClock, accounts, notes]);

    expect(app.flags).toEqual([{ slug: "notes.sharing", owner: "notes team" }]);
    expect(app.access).toEqual([{ entity: { wireName: "audit/log" } }]);
    expect(app.untrackedAuditTables).toEqual(["request_log"]);
    expect(app.auditScopes).toEqual([
      { table: "note", columns: { workspace: "workspace_id" } },
    ]);
    expect(setup).not.toHaveBeenCalled();
  });

  it("preserves the declared access shape across plugins", () => {
    const first = { entity: { wireName: "first" }, first: () => 1 };
    const second = { entity: { wireName: "second" }, second: () => 2 };
    const app = composeApp([
      definePlugin({ name: "first", contributes: { access: [first] } }),
      definePlugin({ name: "second", contributes: { access: [second] } }),
    ]);
    expectTypeOf(app.access).toEqualTypeOf<
      readonly (typeof first | typeof second)[]
    >();
    expect(app.access).toEqual([first, second]);
  });

  it("turns absolute migration folders into workspace-relative sources owned by the plugin", () => {
    const migrating = definePlugin({
      name: "notes-store",
      contributes: {
        migrations: [{ directory: "/srv/app/node_modules/notes/migrations/" }],
      },
    });
    const [source] = composeApp([migrating]).migrationSources("/srv/app");

    expect(source).toMatchObject({
      root: "node_modules/notes/migrations",
      owner: "notes-store",
      required: true,
    });
    expect(
      source?.files.test(
        "node_modules/notes/migrations/20261119000000_notes.migration.ts",
      ),
    ).toBe(true);
    expect(
      source?.files.test("node_modules/notes/migrations/nested/x.migration.ts"),
    ).toBe(false);
    expect(() =>
      composeApp([migrating]).migrationSources("/srv/other"),
    ).toThrow("is not under the workspace root");
  });
});

describe("composeApp: start and stop", () => {
  it("hands each plugin what it requires and collects routes and jobs in setup order", async () => {
    const running = await composeApp([notes, fixedClock, accounts]).start();

    expect(running.routes).toEqual([{ method: "GET", path: "/notes" }]);
    expect(running.jobs).toEqual([{ name: "notes.prune", stampedAt: 42 }]);
    expect(running.read(notes)).toEqual({ owner: "account u1" });
    expect(running.read(clockService).now()).toBe(42);
    await running.stop();
  });

  it("stops plugins last-started first, once", async () => {
    const stopped: string[] = [];
    const recording = (name: string) =>
      definePlugin({
        name,
        setup: ({ scope }) => {
          scope.onDispose(() => {
            stopped.push(name);
          });
          return {};
        },
      });
    const running = await composeApp([
      recording("one"),
      recording("two"),
    ]).start();

    await Promise.all([running.stop(), running.stop()]);

    expect(stopped).toEqual(["two", "one"]);
  });

  it("disposes every plugin even when one disposer fails, then throws PluginStopError", async () => {
    const stopped: string[] = [];
    const failing = definePlugin({
      name: "failing",
      setup: ({ scope }) => {
        scope.onDispose(() => {
          throw new Error("worker would not close");
        });
        return {};
      },
    });
    const healthy = definePlugin({
      name: "healthy",
      setup: ({ scope }) => {
        scope.onDispose(() => {
          stopped.push("healthy");
        });
        return {};
      },
    });
    const running = await composeApp([healthy, failing]).start();

    await expect(running.stop()).rejects.toThrow(PluginStopError);
    expect(stopped).toEqual(["healthy"]);
  });

  it("rolls back the plugins already started when a later setup fails", async () => {
    const stopped: string[] = [];
    const started = definePlugin({
      name: "started",
      setup: ({ scope }) => {
        scope.onDispose(() => {
          stopped.push("started");
        });
        return {};
      },
    });
    const broken = definePlugin({
      name: "broken",
      setup: ({ scope }) => {
        scope.onDispose(() => {
          stopped.push("broken");
        });
        throw new Error("no database");
      },
    });

    const failure = composeApp([started, broken]).start();

    await expect(failure).rejects.toThrow(PluginStartError);
    await expect(failure).rejects.toMatchObject({ pluginName: "broken" });
    expect(stopped).toEqual(["broken", "started"]);
  });

  it("refuses two plugins' jobs with one name after rolling everything back", async () => {
    const withJob = (name: string) =>
      definePlugin({ name, setup: () => ({ jobs: [{ name: "sweep" }] }) });

    await expect(
      composeApp([withJob("one"), withJob("two")]).start(),
    ).rejects.toThrow("job sweep is contributed by both one and two");
  });
});

describe("composeApp: compile-time checks", () => {
  it("keeps each contribution's own type through composition", async () => {
    const running = await composeApp([notes, fixedClock, accounts]).start();
    expectTypeOf(running.routes).toEqualTypeOf<
      readonly { method: string; path: string }[]
    >();
    expectTypeOf(running.read(accounts).find).toEqualTypeOf<
      (id: string) => string
    >();
    await running.stop();
  });

  it("asks for no extra argument when every dependency is offered", () => {
    expectTypeOf<
      DependencyCheck<"plugin:accounts" | "service:clock", "plugin:accounts">
    >().toEqualTypeOf<[]>();
  });

  it("demands an argument naming the unmet dependency when one is missing", () => {
    expectTypeOf<
      DependencyCheck<"plugin:notes", "plugin:accounts" | "plugin:notes">
    >().toEqualTypeOf<[unmetDependency: "unmet dependency: plugin:accounts"]>();
    expectTypeOf(notes.requires).toEqualTypeOf<
      readonly Dependency<"plugin:accounts" | "service:clock", unknown>[]
    >();
  });
});

it("refuses two plugins claiming the same table with different audit policies", () => {
  const scoped = definePlugin({
    name: "scoped",
    contributes: { audit: { scopes: [{ table: "note", columns: {} }] } },
  });
  const excluded = definePlugin({
    name: "excluded",
    contributes: { audit: { untrackedTables: ["note"] } },
  });
  expect(() => composeApp([scoped, excluded])).toThrow(/audit table.*note/u);
});
