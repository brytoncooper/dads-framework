const commands = {
  domain: true,
  endpoint: true,
  table: true,
  access: true,
  flag: true,
  email: true,
  page: true,
  resource: true,
};
type GeneratorKind = keyof typeof commands;

export function isGeneratorCommand(command: string | undefined): command is GeneratorKind {
  return command !== undefined && Object.hasOwn(commands, command);
}

export const GENERATOR_USAGE =
  "dad add domain|endpoint|table|access|flag|email|page|resource <name> [--domain <name>] [--api <name>] [--dry-run] [--json]";

export type GeneratorArguments = {
  readonly kind: GeneratorKind;
  readonly name: string;
  readonly domain: string;
  readonly api: string | undefined;
  readonly dryRun: boolean;
};

export function parseGeneratorArguments(args: readonly string[]): GeneratorArguments {
  const [command, itemName, ...flags] = args;
  if (!isGeneratorCommand(command) || itemName === undefined) throw new Error(GENERATOR_USAGE);

  const kind = command;
  const options = readFlags(flags);
  const name = readGeneratorName("name", itemName);
  return {
    kind,
    name,
    domain: resolveDomain(kind, name, options.get("--domain")),
    api: resolveApi(kind, options.get("--api")),
    dryRun: options.has("--dry-run"),
  };
}

function resolveDomain(kind: GeneratorKind, name: string, option: boolean | string | undefined): string {
  if (kind === "domain") {
    if (option !== undefined) throw new Error("Use the domain name as the command argument.");
    return name;
  }
  if (typeof option === "string") return readGeneratorName("domain", option);
  if (kind === "resource") return name;
  throw new Error("--domain is required.");
}

function resolveApi(kind: GeneratorKind, option: boolean | string | undefined): string | undefined {
  if (typeof option !== "string") {
    if (kind === "resource") throw new Error("--api is required to expose a resource.");
    return undefined;
  }
  if (!supportsApi(kind)) throw new Error("--api is allowed for domain, endpoint, and resource.");
  return readGeneratorName("API", option);
}

function supportsApi(kind: GeneratorKind): boolean {
  return kind === "domain" || kind === "endpoint" || kind === "resource";
}

function readGeneratorName(kind: string, value: string): string {
  if (!/^[a-z][a-z0-9]{0,23}(?:-[a-z][a-z0-9]*)*$/.test(value) || value.length > 28) {
    throw new Error(`Use a lowercase kebab-case ${kind} of up to 28 characters.`);
  }
  return value;
}

function readFlags(args: readonly string[]) {
  const options = new Map<string, boolean | string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === undefined) throw new Error(GENERATOR_USAGE);
    if (options.has(flag)) throw new Error(`Duplicate option ${flag}.`);
    if (flag === "--json" || flag === "--dry-run") {
      options.set(flag, true);
      continue;
    }
    if (flag !== "--api" && flag !== "--domain") throw new Error(GENERATOR_USAGE);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    options.set(flag, value);
  }
  return options;
}
