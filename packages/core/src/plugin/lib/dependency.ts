/**
 * What one plugin may depend on: another plugin, or a service some plugin
 * implements. Both are plain values the dependent imports, never a string it
 * looks up.
 */

/**
 * One start of a composed app. Every plugin and service keeps the value it
 * offers per run, so the same plugin value can run in two compositions at
 * once (two tests in one process) without either seeing the other's state.
 */
export class CompositionRun {
  private readonly startedAt = Date.now();

  /** When this run began, for error messages only. */
  describe(): string {
    return `composition run started at ${new Date(this.startedAt).toISOString()}`;
  }
}

export type DependencyKind = "plugin" | "service";

/**
 * A typed handle on something a plugin needs. `dependencyName` is
 * `plugin:<name>` or `service:<name>`: the compiler compares these to refuse
 * a composition that leaves a dependency unmet.
 */
export type Dependency<DependencyName extends string, Value> = {
  readonly kind: DependencyKind;
  readonly name: string;
  readonly dependencyName: DependencyName;
  /** The value offered in this run. Throws when nothing offered one. */
  readonly read: (run: CompositionRun) => Value;
};

export type AnyDependency = Dependency<string, unknown>;

/** The value a dependency hands its dependents. */
export type DependencyValue<Declared> = Declared extends Dependency<string, infer Value> ? Value : never;

/** Per-run storage for one offered value, typed without an assertion. */
export class OfferedValues<Value> {
  private readonly values = new WeakMap<CompositionRun, { readonly value: Value }>();

  constructor(private readonly owner: string) {}

  remember(run: CompositionRun, value: Value): void {
    this.values.set(run, { value });
  }

  read(run: CompositionRun): Value {
    const box = this.values.get(run);
    if (box === undefined) {
      throw new Error(
        `${this.owner} has no value in this ${run.describe()}: it is not part of the composition, has not started yet, or its setup returned no \`provides\``,
      );
    }
    return box.value;
  }
}
