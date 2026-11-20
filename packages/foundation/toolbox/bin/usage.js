const addCommands = [
  "  add library <name> [--dry-run] [--json]",
  "  add domain|endpoint|table|access|flag|email|page|resource <name> [--domain <name>] [--api <name>] [--dry-run] [--json]",
];

export const usage = [
  "Usage: dad <command>",
  "  init <path> [--existing] [--name <name>] [--dry-run] [--skip-install] [--json]",
  ...addCommands,
  "  add --help",
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
  "  skills:sync [--json]",
  "",
  "Examples",
  "  dad init ./catalog",
  "  dad add resource products --api customer --dry-run",
  "  dad orient domains/products/index.ts --json",
].join("\n");

const addUsage = ["Usage: dad add <generator>", ...addCommands].join("\n");

export function helpFor(args) {
  const [command, subject] = args;
  if (command === "--help" || command === "help") return usage;
  if (command === "add" && (subject === "--help" || subject === "-h"))
    return addUsage;
  return undefined;
}
