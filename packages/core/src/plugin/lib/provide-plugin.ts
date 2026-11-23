import { definePlugin, type Plugin } from "./define-plugin.js";
import type { Service } from "./define-service.js";
import type { PluginScope } from "./plugin-scope.js";

/**
 * A plugin that implements one service with a value the host builds: a
 * database pool, a clock, a mail sender. `create` may return a subtype of the
 * service's value: consumers of the service see the service type, while direct
 * readers of the plugin keep the narrower provided type. `create` registers its
 * own cleanup on `scope` (`scope.onDispose(() => pool.end())`), so the host's
 * resources stop with the plugins that use them.
 */
export function providePlugin<
  const Name extends string,
  ServiceName extends string,
  Value,
  Provided extends Value = Value,
>(
  name: Name,
  service: Service<ServiceName, Value>,
  create: (scope: PluginScope) => Provided | Promise<Provided>,
): Plugin<Name, never, Provided, never, never, never, ServiceName, never> {
  return definePlugin<Name, [], Provided, never, never, never, ServiceName>({
    name,
    implements: service,
    setup: async ({ scope }) => ({ provides: await create(scope) }),
  });
}
