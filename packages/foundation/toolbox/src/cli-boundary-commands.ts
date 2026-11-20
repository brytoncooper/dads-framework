import { writeOutput } from "./cli-io.js";
import { checkDomainBoundaries } from "./domain-boundaries/check-domain-boundaries.js";

export function checkBoundaries(args: readonly string[], json: boolean): void {
  if (args.some((argument) => argument !== "--json")) {
    throw new Error("Usage: dad check boundaries [--json]");
  }
  const result = checkDomainBoundaries(process.cwd());
  if (json || result.ok) {
    writeOutput(result, json);
  } else {
    for (const issue of result.violations) {
      process.stderr.write(
        `${issue.source}:${issue.line}:${issue.column} imports ${issue.target}. ${issue.message}\n`,
      );
    }
  }
  if (!result.ok) process.exitCode = 1;
}
