/**
 * No behavior lives in this file — it is not a wrapper or a pass-through.
 * This abstract class is the port for the `request_log` retention sweep:
 * the type the prune job holds AND the injection token
 * composition binds. `DrizzleRequestLogWriter` (database/writers/)
 * implements it; a fake stands in for the job's unit tests.
 */
export abstract class RequestLogWriter {
  /**
   * Delete every `request_log` row recorded strictly before `cutoff` and
   * return how many rows were removed. `request_log` carries no
   * `audit_record` trigger (it is allowlisted — see
   * `AUDIT_TRIGGER_ALLOWLIST`), so this delete produces no `audit_log` row.
   */
  abstract deleteRecordedBefore(cutoff: Date): Promise<number>;
}
