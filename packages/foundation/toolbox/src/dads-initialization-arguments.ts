export type DadsProjectTemplate = "minimal" | "example";

export type DadsInitializationArguments = {
  readonly targetDirectory: string;
  readonly mode: "new" | "existing";
  readonly projectName?: string;
  readonly template: DadsProjectTemplate;
  readonly acceptDefaults: boolean;
  readonly dryRun: boolean;
  readonly skipInstall: boolean;
  readonly json: boolean;
};

/** Everything one argument sweep can still be missing, before it is required. */
type PartialInitializationArguments = {
  targetDirectory: string | undefined;
  mode: "new" | "existing";
  projectName: string | undefined;
  template: DadsProjectTemplate;
  acceptDefaults: boolean;
  dryRun: boolean;
  skipInstall: boolean;
  json: boolean;
};

export function parseDadsInitializationArguments(
  argumentsAfterCommand: readonly string[],
): DadsInitializationArguments {
  const parsed: PartialInitializationArguments = {
    targetDirectory: undefined,
    mode: "new",
    projectName: undefined,
    template: "example",
    acceptDefaults: false,
    dryRun: false,
    skipInstall: false,
    json: false,
  };
  const seenOptions = new Set<string>();

  for (let index = 0; index < argumentsAfterCommand.length; index += 1) {
    const argument = argumentsAfterCommand[index];
    if (!argument) continue;

    if (!argument.startsWith("--")) {
      recordTargetDirectory(parsed, argument);
      continue;
    }

    recordOption(argument, seenOptions);
    index += applyInitializationOption(parsed, argumentsAfterCommand, index, argument);
  }

  return createInitializationArguments(parsed);
}

function recordTargetDirectory(parsed: PartialInitializationArguments, argument: string): void {
  if (parsed.targetDirectory) {
    throw new Error(`Unexpected positional argument ${argument}.`);
  }
  parsed.targetDirectory = argument;
}

/** Applies one `--option`, answering how many further arguments it consumed. */
function applyInitializationOption(
  parsed: PartialInitializationArguments,
  argumentsAfterCommand: readonly string[],
  optionIndex: number,
  option: string,
): number {
  if (applyInitializationFlag(parsed, option)) return 0;
  applyInitializationValue(parsed, argumentsAfterCommand, optionIndex, option);
  return 1;
}

/** Answers whether `option` was a standalone flag, applying it when it was. */
function applyInitializationFlag(parsed: PartialInitializationArguments, option: string): boolean {
  if (option === "--existing") parsed.mode = "existing";
  else if (option === "--yes") parsed.acceptDefaults = true;
  else if (option === "--dry-run") parsed.dryRun = true;
  else if (option === "--skip-install") parsed.skipInstall = true;
  else if (option === "--json") parsed.json = true;
  else return false;
  return true;
}

function applyInitializationValue(
  parsed: PartialInitializationArguments,
  argumentsAfterCommand: readonly string[],
  optionIndex: number,
  option: string,
): void {
  if (option === "--name") {
    parsed.projectName = readOptionValue(argumentsAfterCommand, optionIndex, option);
    return;
  }
  if (option === "--template") {
    parsed.template = parseProjectTemplate(readOptionValue(argumentsAfterCommand, optionIndex, option));
    return;
  }
  throw new Error(`Unknown option ${option}.`);
}

function parseProjectTemplate(value: string): DadsProjectTemplate {
  if (value === "minimal" || value === "example") return value;
  throw new Error("--template must be minimal or example.");
}

function createInitializationArguments(parsed: PartialInitializationArguments): DadsInitializationArguments {
  const { targetDirectory } = parsed;
  if (!targetDirectory) {
    throw new Error("Provide a Dads project directory.");
  }

  return {
    targetDirectory,
    mode: parsed.mode,
    ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
    template: parsed.template,
    acceptDefaults: parsed.acceptDefaults,
    dryRun: parsed.dryRun,
    skipInstall: parsed.skipInstall,
    json: parsed.json,
  };
}

function recordOption(option: string, seenOptions: Set<string>): void {
  if (seenOptions.has(option)) {
    throw new Error(`Option ${option} was provided more than once.`);
  }
  seenOptions.add(option);
}

function readOptionValue(argumentsAfterCommand: readonly string[], optionIndex: number, option: string): string {
  const optionValue = argumentsAfterCommand[optionIndex + 1];
  if (!optionValue || optionValue.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return optionValue;
}
