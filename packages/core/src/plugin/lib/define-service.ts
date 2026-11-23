import {
  type CompositionRun,
  type Dependency,
  OfferedValues,
} from "./dependency.js";

/**
 * A capability a plugin depends on without naming which plugin offers it.
 * Exactly one plugin in a composition implements it; the host can implement
 * one with `providePlugin` (a database pool, a clock).
 */
export type Service<Name extends string, Value> = Dependency<
  `service:${Name}`,
  Value
> & {
  readonly kind: "service";
  /** Called by the implementing plugin once per run, after its setup. */
  readonly bind: (run: CompositionRun, value: Value) => void;
};

/**
 * What `definePlugin({ implements })` accepts. `bind` takes the plugin's own
 * offered value, so the compiler refuses a plugin whose value does not fit
 * the service it claims to implement.
 */
export type ServiceBinding<Name extends string, Value> = {
  readonly kind: "service";
  readonly name: string;
  readonly dependencyName: `service:${Name}`;
  readonly bind: (run: CompositionRun, value: Value) => void;
};

export type AnyServiceBinding = ServiceBinding<string, never>;

/**
 * Declare a service by name, then its value type:
 * `defineService("clock").ofType<Clock>()`.
 */
export function defineService<const Name extends string>(
  name: Name,
): { readonly ofType: <Value>() => Service<Name, Value> } {
  if (name.trim().length === 0) {
    throw new Error("A service name must not be empty");
  }
  return { ofType: () => createService(name) };
}

function createService<Name extends string, Value>(
  name: Name,
): Service<Name, Value> {
  const values = new OfferedValues<Value>(`service ${name}`);
  const dependencyName: `service:${Name}` = `service:${name}`;
  return {
    kind: "service",
    name,
    dependencyName,
    read: (run) => values.read(run),
    bind: (run, value) => {
      values.remember(run, value);
    },
  };
}
