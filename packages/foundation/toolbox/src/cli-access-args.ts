/** Argument parsers for `dad access` subcommands. */

export type ParsedAccessImportArguments = {
  readonly inputPath: string;
  readonly outPath?: string;
  readonly dryRun: boolean;
};

export type ParsedAccessTreeArguments = {
  readonly inputPath: string;
};

export type ParsedAccessDiffArguments = {
  readonly beforePath: string;
  readonly afterPath: string;
};

export type ParsedAccessMigrateArguments = {
  readonly slug: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly outDir?: string;
  readonly dryRun: boolean;
};

type PartialImportArguments = {
  inputPath: string | undefined;
  outPath: string | undefined;
  dryRun: boolean;
};

type PartialMigrateArguments = {
  slug: string | undefined;
  fromPath: string | undefined;
  toPath: string | undefined;
  outDir: string | undefined;
  dryRun: boolean;
};

export function parseAccessImportArguments(
  commandArguments: readonly string[],
): ParsedAccessImportArguments {
  const parsed: PartialImportArguments = {
    inputPath: undefined,
    outPath: undefined,
    dryRun: false,
  };
  const seenOptions = new Set<string>();

  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    if (!argument) continue;
    if (!argument.startsWith("-")) {
      parsed.inputPath = assignSinglePositional(parsed.inputPath, argument);
      continue;
    }
    recordUniqueOption(seenOptions, argument);
    index += applyImportOption(parsed, commandArguments, index, argument);
  }

  if (parsed.inputPath === undefined) {
    throw new Error("access import requires a path to a .zed schema file.");
  }
  return {
    inputPath: parsed.inputPath,
    ...(parsed.outPath !== undefined ? { outPath: parsed.outPath } : {}),
    dryRun: parsed.dryRun,
  };
}

export function parseAccessTreeArguments(
  commandArguments: readonly string[],
): ParsedAccessTreeArguments {
  let inputPath: string | undefined;
  const seenOptions = new Set<string>();

  for (const argument of commandArguments) {
    if (!argument) continue;
    if (!argument.startsWith("-")) {
      inputPath = assignSinglePositional(inputPath, argument);
      continue;
    }
    recordUniqueOption(seenOptions, argument);
    if (argument !== "--json") {
      throw new Error(`Unknown option ${argument}.`);
    }
  }

  if (inputPath === undefined) {
    throw new Error(
      "access tree requires a path to a .ts or .zed access file.",
    );
  }
  return { inputPath };
}

export function parseAccessDiffArguments(
  commandArguments: readonly string[],
): ParsedAccessDiffArguments {
  const positionals: string[] = [];
  const seenOptions = new Set<string>();

  for (const argument of commandArguments) {
    if (!argument) continue;
    if (!argument.startsWith("-")) {
      if (positionals.length >= 2) {
        throw new Error(`Unexpected positional argument ${argument}.`);
      }
      positionals.push(argument);
      continue;
    }
    recordUniqueOption(seenOptions, argument);
    if (argument !== "--json") {
      throw new Error(`Unknown option ${argument}.`);
    }
  }

  const [beforePath, afterPath] = positionals;
  if (beforePath === undefined || afterPath === undefined) {
    throw new Error(
      "access diff requires <before> and <after> schema file paths (.ts or .zed).",
    );
  }
  return { beforePath, afterPath };
}

export function parseAccessMigrateArguments(
  commandArguments: readonly string[],
): ParsedAccessMigrateArguments {
  const parsed: PartialMigrateArguments = {
    slug: undefined,
    fromPath: undefined,
    toPath: undefined,
    outDir: undefined,
    dryRun: false,
  };
  const seenOptions = new Set<string>();

  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    if (!argument) continue;
    if (!argument.startsWith("-")) {
      parsed.slug = assignSinglePositional(parsed.slug, argument);
      continue;
    }
    recordUniqueOption(seenOptions, argument);
    index += applyMigrateOption(parsed, commandArguments, index, argument);
  }

  return finalizeMigrateArguments(parsed);
}

function assignSinglePositional(
  current: string | undefined,
  argument: string,
): string {
  if (current !== undefined) {
    throw new Error(`Unexpected positional argument ${argument}.`);
  }
  return argument;
}

function recordUniqueOption(seenOptions: Set<string>, option: string): void {
  if (seenOptions.has(option)) {
    throw new Error(`Option ${option} was provided more than once.`);
  }
  seenOptions.add(option);
}

function readAccessOptionValue(
  commandArguments: readonly string[],
  optionIndex: number,
  option: string,
): string {
  const value = commandArguments[optionIndex + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function applyImportOption(
  parsed: PartialImportArguments,
  commandArguments: readonly string[],
  optionIndex: number,
  option: string,
): number {
  if (option === "--dry-run") {
    parsed.dryRun = true;
    return 0;
  }
  if (option === "--json") {
    return 0;
  }
  if (option === "--out") {
    parsed.outPath = readAccessOptionValue(
      commandArguments,
      optionIndex,
      option,
    );
    return 1;
  }
  throw new Error(`Unknown option ${option}.`);
}

function applyMigrateOption(
  parsed: PartialMigrateArguments,
  commandArguments: readonly string[],
  optionIndex: number,
  option: string,
): number {
  if (option === "--dry-run") {
    parsed.dryRun = true;
    return 0;
  }
  if (option === "--json") {
    return 0;
  }
  if (option === "--from") {
    parsed.fromPath = readAccessOptionValue(
      commandArguments,
      optionIndex,
      option,
    );
    return 1;
  }
  if (option === "--to") {
    parsed.toPath = readAccessOptionValue(
      commandArguments,
      optionIndex,
      option,
    );
    return 1;
  }
  if (option === "--out") {
    parsed.outDir = readAccessOptionValue(
      commandArguments,
      optionIndex,
      option,
    );
    return 1;
  }
  throw new Error(`Unknown option ${option}.`);
}

function finalizeMigrateArguments(
  parsed: PartialMigrateArguments,
): ParsedAccessMigrateArguments {
  if (parsed.slug === undefined) {
    throw new Error("access migrate requires a migration slug.");
  }
  if (parsed.fromPath === undefined) {
    throw new Error("access migrate requires --from <before>.");
  }
  if (parsed.toPath === undefined) {
    throw new Error("access migrate requires --to <after>.");
  }
  return {
    slug: parsed.slug,
    fromPath: parsed.fromPath,
    toPath: parsed.toPath,
    ...(parsed.outDir !== undefined ? { outDir: parsed.outDir } : {}),
    dryRun: parsed.dryRun,
  };
}
