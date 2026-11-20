/**
 * The narrow edge every `dad` command shares: reading one option out of an
 * argument list and writing one result to stdout.
 *
 * Keeping it here is what lets each command family read as a list of decisions
 * rather than as argument bookkeeping.
 */

export function writeOutput(value: object, json: boolean): void {
  process.stdout.write(
    json ? `${JSON.stringify(value)}\n` : `${formatHumanOutput(value)}\n`,
  );
}

function formatHumanOutput(value: object): string {
  return JSON.stringify(value, null, 2);
}

export function readOption(
  commandArguments: readonly string[],
  optionName: string,
): string | undefined {
  const optionIndexes = commandArguments.flatMap((argument, index) =>
    argument === optionName ? [index] : [],
  );
  if (optionIndexes.length > 1) {
    throw new Error(`${optionName} may only be provided once.`);
  }
  const optionIndex = optionIndexes[0];
  if (optionIndex === undefined) return undefined;
  const optionValue = commandArguments[optionIndex + 1];
  if (!optionValue || optionValue.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return optionValue;
}
