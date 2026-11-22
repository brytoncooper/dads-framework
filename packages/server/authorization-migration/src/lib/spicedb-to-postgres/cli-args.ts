export const IMPORT_SPICEDB_USAGE = [
  "Usage: dads-import-spicedb --endpoint <host:port> [options]",
  "",
  "Migrate a live SpiceDB schema and relationships into Postgres.",
  "",
  "Options:",
  "  --endpoint <host:port>      SpiceDB gRPC endpoint (required)",
  "  --token <preshared-key>     SpiceDB preshared key (or SPICEDB_TOKEN env)",
  "  --database-url <url>        Postgres connection URL (or DATABASE_URL env)",
  '  --namespace <name>          Target Postgres namespace (default: "default")',
  "  --out <path>                Write generated TypeScript access model to path",
  "  --batch-size <n>            Positive integer batch size for Postgres upserts",
  "  --verify                    Verify SpiceDB/Postgres decision parity after migration",
  "  --insecure                  Use plaintext/insecure localhost connection to SpiceDB",
  "  --dry-run                   Read schema and emit TS preview without writing",
  "  --json                      Emit structured JSON output",
  "  -h, --help                  Show this help message",
].join("\n");

export type ImportSpiceDbCliOptions = {
  readonly endpoint: string;
  readonly token: string;
  readonly databaseUrl?: string;
  readonly namespace: string;
  readonly out?: string;
  readonly batchSize?: number;
  readonly verify: boolean;
  readonly insecure: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
};

export type ParseImportSpiceDbArgsResult =
  | { readonly kind: "help"; readonly usage: string }
  | { readonly kind: "options"; readonly options: ImportSpiceDbCliOptions }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly usage: string;
    };

type ValueFlag =
  | "--endpoint"
  | "--token"
  | "--database-url"
  | "--namespace"
  | "--out"
  | "--batch-size";

type BooleanFlag = "--verify" | "--insecure" | "--dry-run" | "--json";

const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  "--endpoint",
  "--token",
  "--database-url",
  "--namespace",
  "--out",
  "--batch-size",
]);

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set<BooleanFlag>([
  "--verify",
  "--insecure",
  "--dry-run",
  "--json",
]);

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

type RawParsedFlags = {
  readonly seen: Set<string>;
  readonly values: Map<ValueFlag, string>;
  readonly booleans: Set<BooleanFlag>;
};

/**
 * Parse CLI arguments and environment fallbacks (`SPICEDB_TOKEN`,
 * `DATABASE_URL`) for `dads-import-spicedb`.
 */
export function parseImportSpiceDbArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ParseImportSpiceDbArgsResult {
  if (argv.some((arg) => HELP_FLAGS.has(arg))) {
    return { kind: "help", usage: IMPORT_SPICEDB_USAGE };
  }

  const parsed = scanTokens(argv);
  if (typeof parsed === "string") {
    return errorResult(parsed);
  }
  return buildOptionsFromRaw(parsed, env);
}

function scanTokens(argv: readonly string[]): RawParsedFlags | string {
  const raw: RawParsedFlags = {
    seen: new Set<string>(),
    values: new Map<ValueFlag, string>(),
    booleans: new Set<BooleanFlag>(),
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    const step = consumeToken(raw, argv, index, token);
    if (typeof step === "string") return step;
    index = step;
  }
  return raw;
}

function consumeToken(
  raw: RawParsedFlags,
  argv: readonly string[],
  index: number,
  token: string,
): number | string {
  const { name, inlineValue } = splitFlagToken(token);
  if (isBooleanFlag(name)) {
    return consumeBooleanFlag(raw, name, inlineValue, index);
  }
  if (isValueFlag(name)) {
    return consumeValueFlag(raw, name, inlineValue, argv, index);
  }
  if (token.startsWith("-")) {
    return `Unknown flag: ${name}`;
  }
  return `Unexpected argument: ${token}`;
}

function consumeBooleanFlag(
  raw: RawParsedFlags,
  flag: BooleanFlag,
  inlineValue: string | undefined,
  index: number,
): number | string {
  if (inlineValue !== undefined) {
    return `Flag ${flag} does not accept a value`;
  }
  if (raw.seen.has(flag)) {
    return `Duplicate flag: ${flag}`;
  }
  raw.seen.add(flag);
  raw.booleans.add(flag);
  return index + 1;
}

function consumeValueFlag(
  raw: RawParsedFlags,
  flag: ValueFlag,
  inlineValue: string | undefined,
  argv: readonly string[],
  index: number,
): number | string {
  if (raw.seen.has(flag)) {
    return `Duplicate flag: ${flag}`;
  }
  const resolved = resolveFlagValue(flag, inlineValue, argv, index);
  if (typeof resolved === "string") return resolved;
  raw.seen.add(flag);
  raw.values.set(flag, resolved.value);
  return resolved.nextIndex;
}

function resolveFlagValue(
  flag: ValueFlag,
  inlineValue: string | undefined,
  argv: readonly string[],
  index: number,
): { readonly value: string; readonly nextIndex: number } | string {
  if (inlineValue !== undefined) {
    return inlineValue.trim() === ""
      ? `Flag ${flag} requires a non-empty value`
      : { value: inlineValue, nextIndex: index + 1 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.trim() === "" || isKnownFlagToken(next)) {
    return `Flag ${flag} requires a value`;
  }
  return { value: next, nextIndex: index + 2 };
}

function buildOptionsFromRaw(
  raw: RawParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
): ParseImportSpiceDbArgsResult {
  const endpoint = readOptionalText(raw.values.get("--endpoint"));
  if (endpoint === undefined) {
    return errorResult("Missing required flag: --endpoint <host:port>");
  }
  const token =
    readOptionalText(raw.values.get("--token")) ??
    readOptionalText(env["SPICEDB_TOKEN"]);
  if (token === undefined) {
    return errorResult(
      "Missing SpiceDB token: pass --token <key> or set SPICEDB_TOKEN",
    );
  }
  return finalizeOptions(raw, env, endpoint, token);
}

function finalizeOptions(
  raw: RawParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  endpoint: string,
  token: string,
): ParseImportSpiceDbArgsResult {
  const dryRun = raw.booleans.has("--dry-run");
  const verify = raw.booleans.has("--verify");
  if (dryRun && verify) {
    return errorResult("--verify cannot be combined with --dry-run");
  }

  const databaseUrl = resolveDatabaseUrl(raw, env, dryRun);
  if (typeof databaseUrl === "object") return databaseUrl;

  const batchSize = parseBatchSize(raw.values.get("--batch-size"));
  if (typeof batchSize === "string") return errorResult(batchSize);

  return {
    kind: "options",
    options: buildCliOptions({
      raw,
      endpoint,
      token,
      dryRun,
      verify,
      databaseUrl,
      batchSize,
    }),
  };
}

function resolveDatabaseUrl(
  raw: RawParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  dryRun: boolean,
): string | undefined | ParseImportSpiceDbArgsResult {
  const databaseUrl =
    readOptionalText(raw.values.get("--database-url")) ??
    readOptionalText(env["DATABASE_URL"]);
  if (!dryRun && databaseUrl === undefined) {
    return errorResult(
      "Missing Postgres URL: pass --database-url <url> or set DATABASE_URL",
    );
  }
  return databaseUrl;
}

function buildCliOptions(input: {
  readonly raw: RawParsedFlags;
  readonly endpoint: string;
  readonly token: string;
  readonly dryRun: boolean;
  readonly verify: boolean;
  readonly databaseUrl: string | undefined;
  readonly batchSize: number | undefined;
}): ImportSpiceDbCliOptions {
  const namespace =
    readOptionalText(input.raw.values.get("--namespace")) ?? "default";
  const out = readOptionalText(input.raw.values.get("--out"));

  return {
    endpoint: input.endpoint,
    token: input.token,
    namespace,
    verify: input.verify,
    insecure: input.raw.booleans.has("--insecure"),
    dryRun: input.dryRun,
    json: input.raw.booleans.has("--json"),
    ...(input.databaseUrl === undefined
      ? {}
      : { databaseUrl: input.databaseUrl }),
    ...(out === undefined ? {} : { out }),
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
  };
}

function parseBatchSize(raw: string | undefined): number | string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    return `Invalid --batch-size "${raw}": must be a positive integer`;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return `Invalid --batch-size "${raw}": must be a positive integer`;
  }
  return parsed;
}

function splitFlagToken(token: string): {
  readonly name: string;
  readonly inlineValue: string | undefined;
} {
  const eqIndex = token.indexOf("=");
  if (eqIndex === -1) {
    return { name: token, inlineValue: undefined };
  }
  return {
    name: token.slice(0, eqIndex),
    inlineValue: token.slice(eqIndex + 1),
  };
}

function isValueFlag(name: string): name is ValueFlag {
  return VALUE_FLAGS.has(name);
}

function isBooleanFlag(name: string): name is BooleanFlag {
  return BOOLEAN_FLAGS.has(name);
}

function isKnownFlagToken(token: string): boolean {
  const { name } = splitFlagToken(token);
  return (
    VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name) || HELP_FLAGS.has(name)
  );
}

function readOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorResult(message: string): ParseImportSpiceDbArgsResult {
  return { kind: "error", message, usage: IMPORT_SPICEDB_USAGE };
}
