import { definePlugin, type Plugin } from "./define-plugin.js";
import type { Service } from "./define-service.js";
import type { PluginScope } from "./plugin-scope.js";

/**
 * A plugin that implements one service with a value the host builds: a
 * database pool, a clock, a mail sender. `create` registers its own cleanup
 * on `scope` (`scope.onDispose(() => pool.end())`), so the host's resources
 * stop with the plugins that use them.
 */
export function providePlugin<
  const Name extends string,
  ServiceName extends string,
  Value,
>(
  name: Name,
  service: Service<ServiceName, Value>,
  create: (scope: PluginScope) => Value | Promise<Value>,
): Plugin<Name, never, Value, never, never, never, ServiceName, never> {
  return definePlugin({
    name,
    implements: service,
    setup: async ({ scope }) => ({ provides: await create(scope) }),
  });
}
