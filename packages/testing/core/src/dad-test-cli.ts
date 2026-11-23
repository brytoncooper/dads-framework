import { parseCommandOptions } from "./cli-arguments.js";
import type { OptionSpecification, ParsedArguments } from "./cli-arguments.js";
import { explainCommand } from "./commands/explain.js";
import { initCommand } from "./commands/init.js";
import { planCommand, runCommand } from "./commands/plan-run.js";

/**
 * The `dad-test` command line as a function of its inputs. Every effect the CLI
 * has — the working directory it plans, the environment it reads, the streams it
 * writes, the exit code it returns — is passed in or returned, so the whole CLI
 * is testable in process without spawning Node.
 */
export type DadTestCliIo = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type DadTestCommand = {
  readonly options: readonly OptionSpecification[];
  readonly execute: (parsed: ParsedArguments, io: DadTestCliIo, json: boolean) => Promise<number>;
};

const usage = "Usage: dad-test plan|run|explain|init [options] [--json]. See the package README for each option.\n";

const commands = new Map<string, DadTestCommand>([
  ["plan", planCommand],
  ["run", runCommand],
  ["explain", explainCommand],
  ["init", initCommand],
]);

/**
 * The command surface `dad-test` accepts, in registration order: each command
 * name with every option it parses. `--json` is listed on every command because
 * the parser accepts it everywhere, so a reader of this list never has to know
 * that it is implicit. Documentation checks read this instead of re-deriving the
 * surface from the source, so a new command or option cannot ship undocumented.
 */
export function listDadTestCommands(): readonly {
  readonly name: string;
  readonly options: readonly string[];
}[] {
  return [...commands].map(([name, command]) => {
    const optionNames = new Set(command.options.map((option) => option.name));
    optionNames.add("--json");
    return { name, options: [...optionNames] };
  });
}

/** Runs one `dad-test` invocation and returns its exit code. */
export async function runDadTestCli(argumentsAfterExecutable: readonly string[], io: DadTestCliIo): Promise<number> {
  // The envelope is chosen before parsing so a parse failure is still reported
  // in the shape the caller asked for.
  const json = argumentsAfterExecutable.includes("--json");
  try {
    const operation = argumentsAfterExecutable[0];
    if (operation === "--help" || operation === "help") {
      io.stdout(usage);
      return 0;
    }
    const command = operation === undefined ? undefined : commands.get(operation);
    if (command === undefined) {
      throw new Error("Expected operation plan, run, explain, or init.");
    }
    const parsed = parseCommandOptions(argumentsAfterExecutable.slice(1), command.options);
    return await command.execute(parsed, io, json);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown failure.";
    io.stderr(json ? `${JSON.stringify({ schemaVersion: 1, ok: false, error: message })}\n` : `dad-test: ${message}\n`);
    return 1;
  }
}
