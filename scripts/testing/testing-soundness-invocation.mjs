import { parseArguments } from "./testing-soundness-lib.mjs";

export const SOUNDNESS_OPTIONS = new Set(["--dad-test", "--output", "--fixture", "--case-jobs", "--shard"]);

export function soundnessInvocation(argv, buildBinary) {
  const options = parseArguments(argv, SOUNDNESS_OPTIONS);
  return [
    ...argv,
    ...(options.has("--dad-test") ? [] : ["--dad-test", buildBinary()]),
    ...(options.has("--output") ? [] : ["--output", "target/soundness-local.json"]),
  ];
}
