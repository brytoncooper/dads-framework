/**
 * One option parser for every `dad-test` command. Each command declares the
 * options it accepts; anything else is a command-line error rather than a
 * silently ignored argument. `--json` is accepted by every command because it
 * selects the output envelope rather than command behaviour.
 */

export type OptionKind = "flag" | "value" | "repeatable" | "optional-value";

export type OptionSpecification = {
  readonly name: `--${string}`;
  readonly kind: OptionKind;
};

export type ParsedArguments = {
  /** Options declared as `flag` that appeared at least once. */
  readonly flags: ReadonlySet<string>;
  /** Values of `value` options, and of `optional-value` options given a value. */
  readonly values: ReadonlyMap<string, string>;
  /** Every value of each `repeatable` option, in command-line order. */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  /** Every option that appeared, whether or not it carried a value. */
  readonly present: ReadonlySet<string>;
};

const jsonOption: OptionSpecification = { name: "--json", kind: "flag" };

/** What has been read so far; the caller reads it as the immutable result. */
type CollectedOptions = {
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
  readonly repeated: Map<string, string[]>;
  readonly present: Set<string>;
};

/** Parses the arguments that follow a command name. */
export function parseCommandOptions(
  argumentsAfterCommand: readonly string[],
  specification: readonly OptionSpecification[],
): ParsedArguments {
  const kinds = declaredOptionKinds(specification);
  const collected: CollectedOptions = {
    flags: new Set<string>(),
    values: new Map<string, string>(),
    repeated: new Map<string, string[]>(),
    present: new Set<string>(),
  };

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (argument === undefined) break;
    index += collectOption(collected, requireDeclaredKind(argument, kinds), argument, argumentsAfterCommand[index + 1]);
  }

  return collected;
}

/** `--json` is accepted everywhere, so every command's kinds start with it. */
function declaredOptionKinds(specification: readonly OptionSpecification[]): ReadonlyMap<string, OptionKind> {
  const kinds = new Map<string, OptionKind>([[jsonOption.name, jsonOption.kind]]);
  for (const option of specification) kinds.set(option.name, option.kind);
  return kinds;
}

/** Anything the command did not declare is a command-line error, not a positional. */
function requireDeclaredKind(argument: string, kinds: ReadonlyMap<string, OptionKind>): OptionKind {
  if (!argument.startsWith("--")) {
    throw new Error(`Unexpected argument ${argument}.`);
  }
  const kind = kinds.get(argument);
  if (kind === undefined) throw new Error(`Unknown option ${argument}.`);
  return kind;
}

/** Records one option and reports how many further arguments it consumed. */
function collectOption(
  collected: CollectedOptions,
  kind: OptionKind,
  argument: string,
  nextArgument: string | undefined,
): number {
  if (kind === "flag") {
    collected.flags.add(argument);
    collected.present.add(argument);
    return 0;
  }

  const value = valueOf(nextArgument);
  requireUsableValue(collected.present, kind, argument, value);
  if (value !== undefined) recordValue(collected, kind, argument, value);
  collected.present.add(argument);
  return value === undefined ? 0 : 1;
}

/** The next argument is this option's value unless it is itself an option. */
function valueOf(nextArgument: string | undefined): string | undefined {
  if (nextArgument === undefined || nextArgument.startsWith("--")) {
    return undefined;
  }
  return nextArgument;
}

function requireUsableValue(
  present: ReadonlySet<string>,
  kind: OptionKind,
  argument: string,
  value: string | undefined,
): void {
  if (kind !== "repeatable" && present.has(argument)) {
    throw new Error(`${argument} may only be provided once.`);
  }
  if (kind !== "optional-value" && value === undefined) {
    throw new Error(`${argument} requires a value.`);
  }
}

function recordValue(collected: CollectedOptions, kind: OptionKind, argument: string, value: string): void {
  if (kind !== "repeatable") {
    collected.values.set(argument, value);
    return;
  }
  const collectedValues = collected.repeated.get(argument) ?? [];
  collectedValues.push(value);
  collected.repeated.set(argument, collectedValues);
}

/** Reads an option value that must be a positive integer. */
export function readPositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}
