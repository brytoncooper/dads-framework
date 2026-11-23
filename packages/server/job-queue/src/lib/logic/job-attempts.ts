/**
 * How many tries a job gets, and whether this one was the last.
 *
 * Pure and its own file because the rule it encodes is easy to get subtly
 * wrong and impossible to see in a queue driver: **only the final failure is a
 * fault.** Reporting every retry would make one flaky job look like a hundred
 * bugs, and a log line that does not say which kind of failure it is makes all
 * of them look equally alarming.
 *
 * BullMQ counts `attemptsMade` INCLUSIVE of the attempt that just failed, so
 * the third failure of a three-attempt job has `attemptsMade === 3`. That is
 * why the comparison below is `>=` and not `>`, and it is the detail this file
 * exists to pin.
 */

export type JobAttempts = {
  /** Attempts finished, including the one that just failed. */
  readonly made: number;
  /** Attempts the job was configured to get, at least one. */
  readonly allowed: number;
};

/** What BullMQ knows about this job's attempts, defaulted for a job it lost. */
export function attemptsOf(job: { attemptsMade?: number; opts?: { attempts?: number } } | undefined): JobAttempts {
  return {
    made: job?.attemptsMade ?? 0,
    // A job with no configured attempts gets one. Defaulting to zero would
    // make every failure look non-terminal and report nothing, ever.
    allowed: Math.max(job?.opts?.attempts ?? 1, 1),
  };
}

/** True when there is no retry left, which is the only failure worth reporting. */
export function isTerminalAttempt(attempts: JobAttempts): boolean {
  return attempts.made >= attempts.allowed;
}
