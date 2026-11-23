const addCommands = [
  "  add library <name> [--dry-run] [--json]",
  "  add workflow|integration <name> [--dry-run] [--json]",
  "  add domain|endpoint|table|access|flag|email|page|resource <name> [--domain <name>] [--api <name>] [--dry-run] [--json]",
];

const accessCommands = [
  "  access import <schema.zed> [--out <path>] [--dry-run] [--json]",
  "  access tree <schema.ts|schema.zed> [--json]",
  "  access diff <before> <after> [--json]",
  "  access migrate <slug> --from <before> --to <after> [--out <dir>] [--dry-run] [--json]",
];

const dbCommands = [
  "  db generate [--database-url <url>] [--out <dir>] [--metadata <path>] [--schema <name>] [--json]",
  "  db check [--database-url <url>] [--out <dir>] [--metadata <path>] [--schema <name>] [--json]",
  "  db migrate [--database-url <url>] [--json]",
  "  db status [--database-url <url>] [--json]",
];

const accessSubcommands = new Set(["import", "tree", "diff", "migrate"]);
const dbSubcommands = new Set(["generate", "check", "migrate", "status"]);

export const usage = [
  "Usage: dad <command>",
  "  init <path> [--existing] [--name <name>] [--template minimal|example] [--dry-run] [--skip-install] [--json]",
  ...addCommands,
  "  add --help",
  ...accessCommands,
  "  access --help",
  ...dbCommands,
  "  db --help",
  "  orient|explain <path> [--json]",
  '  inspect http-operation "<METHOD /path>" [--json]',
  "  check boundaries [--json]",
  "  baseline init [path] --reason <text> [--today YYYY-MM-DD] [--json]",
  "  doctor [path] [--profile standard|strict] [--issue <id>] [--online] [--json]",
  "    [--today YYYY-MM-DD] [--gate|--update|--seed|--report|--file <path>|--base <ref>] [--reason <text>] [--key <key>]",
  "  doctor explain <issue-id> [--profile standard|strict] [--json]",
  "  test plan|run|explain|init [--manifest path] [--base ref] [--head ref] [--all] [--task id] [--jobs n] [--report [path]] [--force] --json",
  "  test:recommend --changed [--base <ref>] [--json]",
  "  verify --changed [--base <ref>] [--full] [--no-cache] [--json]",
  "  migrate 0.3 [path] [--dry-run] [--json]",
  "  skills:sync [--json]",
  "",
  "Examples",
  "  dad init ./catalog",
  "  dad init ./catalog --template minimal",
  "  dad add resource products --api customer --dry-run",
  "  dad access import schema.zed --out src/access.ts",
  "  dad access tree src/access.ts",
  "  dad access diff before.ts after.ts",
  "  dad access migrate rename_editor --from before.ts --to after.ts",
  "  dad orient domains/products/index.ts --json",
].join("\n");

const addUsage = ["Usage: dad add <generator>", ...addCommands].join("\n");
const accessUsage = ["Usage: dad access <subcommand>", ...accessCommands].join("\n");
const dbUsage = ["Usage: dad db <generate|check|migrate|status>", ...dbCommands].join("\n");

function isHelpFlag(argument) {
  return argument === "--help" || argument === "-h";
}

export function helpFor(args) {
  const [command, subject, detail] = args;
  if (command === "--help" || command === "help") return usage;
  if (command === "add" && isHelpFlag(subject)) return addUsage;
  if (command === "access" && isHelpFlag(subject)) return accessUsage;
  if (command === "access" && accessSubcommands.has(subject) && isHelpFlag(detail)) return accessUsage;
  if (command === "db" && isHelpFlag(subject)) return dbUsage;
  if (command === "db" && dbSubcommands.has(subject) && isHelpFlag(detail)) return dbUsage;
  return undefined;
}
