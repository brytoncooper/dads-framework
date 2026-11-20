import { appendFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

export function recordHookTiming(hook, startedAt) {
  const durationMs = Math.round(performance.now() - startedAt);
  try {
    mkdirSync(".dads", { recursive: true });
    appendFileSync(
      ".dads/hook-timings.jsonl",
      `${JSON.stringify({ hook, durationMs })}\n`,
    );
  } catch {
    // Local timing is diagnostic and must not change the hook's exit status.
  }
}
