import type { OptionSpecification } from "../cli-arguments.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { checkTestingBoundaries, type TestingBoundariesResult } from "../testing-api.js";

const checkBoundariesOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--config", kind: "value" },
];

export const checkBoundariesCommand: DadTestCommand = {
  options: checkBoundariesOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const base = parsed.values.get("--base");
    const head = parsed.values.get("--head");
    const configPath = parsed.values.get("--config");

    const result = await checkTestingBoundaries({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(base === undefined ? {} : { base }),
      ...(head === undefined ? {} : { head }),
      ...(configPath === undefined ? {} : { boundariesConfigPath: configPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });

    io.stdout(json ? `${JSON.stringify({ schemaVersion: 1, ok: true, result })}\n` : renderBoundariesResult(result));
    return result.violations.length === 0 ? 0 : 1;
  },
};

/** Formats native module-boundary check results for human readers. */
export function renderBoundariesResult(result: TestingBoundariesResult): string {
  const lines: string[] = [];
  for (const violation of result.violations) {
    const target = violation.targetProject ?? "external";
    lines.push(
      `${violation.file}:${String(violation.line)}:${String(violation.column)} [${violation.rule}] (${violation.sourceProject} -> ${target}) ${violation.message}`,
    );
  }
  const count = result.violations.length;
  const noun = count === 1 ? "violation" : "violations";
  lines.push(
    `check-boundaries: ${String(count)} ${noun} across ${String(result.checkedFiles)} files (${String(result.totalProjects)} projects).`,
  );
  return `${lines.join("\n")}\n`;
}
