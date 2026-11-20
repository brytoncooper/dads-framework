# `@dads-framework/plugin`

The build-time plugin contract: a plugin is a package that exports one typed `definePlugin({...})` value, and an app composes its plugins explicitly in code with `composeApp([...])`, which orders them, refuses what cannot form one app, and returns everything the host wires plus a `start()` whose `stop()` disposes every effect the plugins started.

## What Dad does for you

A plugin you cannot see is a plugin you cannot reason about. Every plugin here is an import, so the compiler, `dad doctor`, and `dad orient` see the whole app.

## Try it

Install the plugin kernel.

```sh
npm install @dads-framework/plugin
```

Save as `plugin.mts` and run `node plugin.mts` with Node.js 22.18 or newer.

<!-- dads:check-example -->

```ts
import { composeApp, definePlugin } from "@dads-framework/plugin";

const notes = definePlugin({
  name: "notes",
  setup: () => ({ provides: { countNotes: () => 0 } }),
});

const running = await composeApp([notes]).start();
try {
  console.log(running.read(notes).countNotes()); // 0
} finally {
  await running.stop();
}
```

The script prints `0` by reading the notes plugin's provided service after
startup. When the script exits, the composed runtime has stopped.

In the generated starter, [`domains/notes/server/plugin.ts`](../../../apps/kit-workbench/domains/notes/server/plugin.ts) declares
the Notes plugin and [`apps/customer/app.ts`](../../../apps/kit-workbench/apps/customer/app.ts) selects it for the customer
API. The links open the starter source in this repo.

## Use it

### Routes, jobs, and declared contributions

The next excerpt shows how a Notes plugin uses a clock service and contributes
migrations, access, flags, HTTP routes, and jobs. The fixture below contains
the surrounding definitions and host wiring.

```ts
import { accessModel } from "@dads-framework/access";
import {
  composeApp,
  definePlugin,
  defineService,
  providePlugin,
} from "@dads-framework/plugin";

type Clock = { readonly now: () => Date };
const clockService = defineService("clock").ofType<Clock>();

const notes = definePlugin({
  name: "notes",
  requires: [clockService],
  contributes: {
    migrations: [
      { directory: fileURLToPath(new URL("./migrations/", import.meta.url)) },
    ],
    access: [noteAccess], // the value access() returned
    flags: [sharingFlag], // a feature-flag definition
    audit: { untrackedTables: ["notes_read_marks"] },
  },
  setup: ({ scope, use }) => {
    const clock = use(clockService);
    const store = new NotesStore();
    scope.interval(() => store.prune(clock.now()), 86_400_000);
    return {
      provides: { countNotes: () => store.count() },
      routes: notesRoutes(store), // routeGroup(...) from @dads-framework/http
      jobs: [pruneJob(store, clock)], // defineJob(...) from @dads-framework/job-queue
    };
  },
});

const hostClock = providePlugin("host-clock", clockService, () => ({
  now: () => new Date(),
}));

const app = composeApp([notes, hostClock]);
app.plugins; // ["host-clock", "notes"]: setup order
app.migrationSources(workspaceRoot); // append to the runner's MigrationWorkspace.sources
const model = accessModel(app.access);

const running = await app.start();
registerRoutes(http, {
  routes: running.routes,
  accessModel: model,
  ...accessPorts,
});
queue.register(running.jobs);
running.read(notes).countNotes(); // 0
await running.stop(); // the interval is cleared
```

`fixtures/plugin-notes` is this example as a package, proven end to end: its
route answers through `@dads-framework/http`, its job runs in the in-process
job queue, `discoverDomainMigrations` finds its migration, and its access
definitions compile through `emitAccessIr(accessModel(app.access))`.

### Entry points

| Entry point                                     | What it is                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `definePlugin(spec)`                            | declare a plugin: `name`, `requires`, `implements`, `contributes`, `setup`                        |
| `defineService(name).ofType<Value>()`           | a capability a plugin requires without naming which plugin offers it                              |
| `providePlugin(name, service, create)`          | a plugin implementing one service with a value the host builds (a pool, a clock)                  |
| `composeApi(name, { services, routes, jobs })`  | select the contributions for one named API                                                        |
| `composeApp(plugins)`                           | order and check a plugin list; returns the declared contributions and `start()`                   |
| `running.read(dependency)`                      | what a plugin or service offers in this run                                                       |
| `@dads-framework/plugin/testing` `startForTest` | start a composed set in a test; `stopCleanly()` refuses failed disposers, live effects, and leaks |
| `@dads-framework/plugin/web` `defineWebPlugin`  | the browser half of a plugin: its pages, with no server code                                      |

### Multiple API entrypoints

Give each API its own composition root. A domain can export a shared service
plugin plus separate customer routes, staff routes, and a worker's job
registration. The host chooses which of those surfaces to mount.

```ts
import { composeApi } from "@dads-framework/plugin";

const customer = composeApi("customer", {
  services: [hostClock, notesData],
  routes: [customerNotes],
  jobs: [],
});

const staff = composeApi("staff", {
  services: [hostClock, notesData],
  routes: [staffNotes],
  jobs: [staffNotesJobs],
});
```

A plugin in `services` contributes its provided value and declared metadata.
Only plugins in `routes` expose routes, and only plugins in `jobs` expose
jobs. Use `jobs: []` for an API with no workers. A plugin appears once in an
API selection. Split independently deployed route and job groups into separate
plugins and list their dependencies in `requires`. Use `composeApp` when every
surface of a plugin ships together.

Only selected plugins participate in an API's composition. A selected plugin
with an unsatisfied dependency fails during composition with the API and
plugin named. Omitting a surface that no selected plugin requires is a valid
configuration. Use `app.access` and `app.migrationSources(workspaceRoot)` to
inspect selected metadata before starting services or opening a database.
Mount `running.routes` and register `running.jobs` on the corresponding host.
Each call to `start()` owns its own runtime. To share durable state across
API processes, configure both service providers to use the same backing store.

See the [customer and staff compositions](../../../fixtures/plugin-notes/README.md)
for an example with authorization and route-isolation proof.

### What a plugin can contribute

Two kinds, split by when they exist.

**Declared** (`contributes`): plain data, readable from `composeApp(plugins)`
without starting anything, so the migration runner, `dad doctor`, and
`dad orient` see them without booting the app.

| Field        | Shape the kernel checks                     | Where the host sends it                                 |
| ------------ | ------------------------------------------- | ------------------------------------------------------- |
| `migrations` | `{ directory, required? }`, absolute folder | `app.migrationSources(root)` into `MigrationWorkspace`  |
| `access`     | `{ entity: { wireName } }` (an `access()`)  | `accessModel(app.access)`                               |
| `flags`      | `{ slug }` (a feature-flag definition)      | `app.flags`, the flag kit's definition list             |
| `audit`      | `{ untrackedTables }`                       | `app.untrackedAuditTables`, the audit trigger allowlist |

**Started** (returned by `setup`): built from running dependencies, because a
route's handler and a job's `run` close over them.

| Field      | Shape the kernel checks | Where the host sends it                       |
| ---------- | ----------------------- | --------------------------------------------- |
| `routes`   | none                    | `running.routes` into `registerRoutes`        |
| `jobs`     | `{ name }`              | `running.jobs` into `JobQueue.register`       |
| `provides` | none                    | `running.read(plugin)`, and to its dependents |

The kernel names only the field it checks. Every item keeps its own kit's
type through inference: `running.routes` is `readonly HttpRoute[]` because the
plugins returned `HttpRoute`s, and this package depends on no kit at all.

**UI pages** are not on `definePlugin`, because one object holding both route
handlers and page components would pull server code into the web bundle. A
plugin package exports `defineWebPlugin({ name, pages })` from its own `./web`
entry, and the web app composes those with `composeWebApp`. A page is any
`{ path }`; the router binding is the app's.

### Dependencies

`requires` lists values: another plugin, or a service. `setup` reads them
with `use(dependency)`, which accepts only what `requires` lists.

- A plugin dependency means "this exact plugin": `requires: [accountsPlugin]`.
- A service dependency means "whatever plugin implements this":
  `requires: [clockService]`. A plugin claims a service with
  `implements: clockService`, and its `provides` must fit the service's type
  or the definition does not compile.

Write `requires` inline (`requires: [accounts]`), so it is inferred as a
tuple of literal names. A list typed as a plain `AnyDependency[]` loses the
names, and `composeApp` then refuses every composition at compile time.

A plugin exposes what it offers as the plain type of `provides`. A dependent
sees that type and nothing else: no store, no table, no internal module.

### Ordering

`composeApp` sets up every plugin after what it requires, and otherwise keeps
the order the app listed them. `stop()` runs in exactly the reverse order of
setup.

| Refusal                                                                             | When                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| dependency not in the list                                                          | compile time: the call demands an `unmetDependency` argument |
| dependency not in the list (non-literal)                                            | `composeApp`, `PluginCompositionError` naming both plugins   |
| `provides` does not fit an implemented service                                      | compile time, on `definePlugin`                              |
| a cycle (possible only through a service)                                           | `composeApp`, naming the plugins in it                       |
| a repeated plugin name, a service implemented twice                                 | `composeApp`                                                 |
| two plugins claiming one flag slug, access entity, audit table, or migration folder | `composeApp`                                                 |
| two plugins' jobs with one name                                                     | `start()`, after rolling back what started                   |

A cycle between plugin values cannot be written: a plugin can only require a
plugin that was already defined. A service is the one way around that, which
is why the cycle check stays.

### Lifecycle

Every effect a plugin starts is registered on its scope and disposed with it.

| `scope.`        | What it does                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `signal`        | an `AbortSignal`, aborted when disposal begins; pass it to listeners, fetches |
| `onDispose(fn)` | run `fn` on disposal                                                          |
| `effect(start)` | run `start` now, register the disposer it returns; returns an early stop      |
| `interval`      | a repeating timer, cleared on disposal                                        |
| `timeout`       | a one-shot timer, cleared on disposal if it has not fired                     |

Disposal aborts the signal, then runs the scope's disposers newest first. A
failed disposer does not skip the rest. `start()` sets plugins up one at a
time; when a setup throws, that plugin's scope and every scope already started
are disposed before `PluginStartError` is thrown. `stop()` disposes every
scope, last-started first, and throws one `PluginStopError` at the end if any
disposer failed; calling it again returns the same promise. An effect
registered after its scope closed is refused with `PluginScopeClosedError`
and never started.

`startForTest(app, { leakProbe })` checks the ledger every scope keeps and,
when given one, a probe of live resources outside it
(`() => vi.getTimerCount()` under fake timers). The ledger can only see what
a plugin registered; the probe is how a test catches what it did not.

## What it refuses to do

- **It does not load plugins at runtime.** No directory scan, no config file
  of package names, no `import()` by string. A plugin the app does not import
  does not exist, so the compiler and the doctor see exactly what runs.
- **It does not inject services by string key.** Dependencies are imported
  values and are read with `use(value)`; a misspelt dependency is a compile
  error, not `undefined` at runtime.
- **It does not depend on any kit.** It names only the fields it checks
  (`name`, `slug`, `wireName`, `directory`), so every kit can depend on it and
  none has to change shape for it.
- **It does not let a plugin dispose itself.** Setup sees `PluginScope`, which
  has no `dispose`; only the composition ends a plugin's lifetime.
- **It does not hot-reload.** A stopped app is started again as a new run;
  nothing is swapped in place.

## Contract

```ts
definePlugin(spec: {
  name: string; // lowercase words joined by dashes
  requires?: readonly (Plugin | Service)[];
  implements?: Service; // provides must fit it
  contributes?: { migrations?; access?; flags?; audit? };
  setup?: (context: { scope: PluginScope; use: (dependency) => Value }) =>
    | { provides?; routes?; jobs? }
    | Promise<{ provides?; routes?; jobs? }>;
}): Plugin;

composeApp(plugins: readonly Plugin[]): {
  plugins: readonly string[]; // setup order
  access: readonly AccessContribution[];
  flags: readonly Flag[];
  untrackedAuditTables: readonly string[];
  migrationSources(workspaceRoot: string): readonly PluginMigrationSource[];
  start(): Promise<RunningApp>;
};

RunningApp: {
  routes: readonly Route[];
  jobs: readonly Job[];
  read(dependency): Value;
  effects(): readonly ScopeLedger[];
  stop(): Promise<void>;
};
```

| Error                    | When                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `PluginCompositionError` | `composeApp`: missing dependency, cycle, duplicate, folder outside the workspace |
| `PluginStartError`       | `start()`: a setup threw; `pluginName`, `cause`, and rollback `disposalErrors`   |
| `PluginStopError`        | `stop()`: one or more disposers threw; `failures` per plugin                     |
| `PluginScopeClosedError` | an effect registered on a disposed scope                                         |
| `PluginLeakError`        | `stopCleanly()`: live effects, or the leak probe rose                            |

`migrationSources(root)` turns each absolute folder into a source relative to
`root` whose pattern matches that folder's own `*.migration.ts` files and
whose `owner` is the plugin's name. The runner journals a migration by its
file name, so where a machine installed the package does not change it.

## Design notes

### Where it lives

`packages/foundation/plugin`, kind `core`, with no dependencies. It is
framework-wide rather than server-only: the kernel and `./web` import nothing
from Node or a vendor, so a web app composes web plugins with it too. And the
kind matrix only lets every other kind (an `adapter` kit included) depend on
a `core` package, which is what lets a kit become a plugin later without a
kind inversion. That is also why it names no kit type.

### Why build-time

This framework's rule is that the compiler and `dad doctor` see everything. A runtime loader trades that for a feature nobody here needs:
adding a plugin without a deploy. So a plugin is an npm package, an app lists
its plugins in code, and composition is a function call whose types carry
every contribution through to the host.

### What we took from Cordis, and what we left

Cordis (the cordiverse plugin kernel) was studied, not adopted.

- **Taken:** every effect is registered against the plugin's scope and
  disposed together (`ctx.effect`, `ctx.on("dispose")`); disposal runs newest
  first; a plugin declares what it needs (`inject`) and starts after it; a
  failed apply leaves no half-started plugin behind.
- **Left:** services as string-keyed properties on a shared context
  (`ctx.database`), replaced by imported `Service` values; runtime plugin
  loading and hot reload; re-applying a plugin when a service comes and goes;
  the shared event bus on the context; reactive config. Each of those trades
  compile-time visibility for runtime flexibility this framework does not want.

### Converting audit, feature flags, and enterprise

Compose audit and feature-flag providers at the host. Domain plugins can
declare audit exclusions and flag definitions while the host supplies the
persistence, clock, and logging. The kit starter passes its selected flags to
its application services.

- **Audit:** Use `contributes.audit.untrackedTables` for plugin-owned
  exclusions. Composition exposes these alongside scope mappings.
- **Feature flags:** Declare a flag under the plugin whose code it gates.
  Pass the composed `app.flags` to the feature-flag provider.
- **Access:** Compose `accessModel(app.access)` in the host. Use that model for
  schema generation and HTTP registration.

An application can use the same contract for an enterprise integration such
as SSO. Declare the identity dependency through `requires` and contribute
migrations, access definitions, and route or job bindings as needed.

## Daddy issues this prevents

The app nobody can draw: plugins discovered from a folder at boot, services
fetched by string, and a shutdown that leaves a timer ticking in the test
runner.

Plugins may declare audit exclusions and scope mappings under
`contributes.audit`. The composed API exposes `untrackedAuditTables` and
`auditScopes` before setup. Each table may have one audit policy claim.
