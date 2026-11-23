/**
 * Refuse a local run that switched off Testcontainers cleanup (Ryuk).
 *
 * Testcontainers ships Ryuk: a sidecar container that holds a socket open to
 * this process and removes the run's containers when that socket dies. It is
 * the ONLY cleanup that survives `kill -9`, because a killed process runs no
 * `afterAll` and no exit handler. It is on by default, and
 * `TESTCONTAINERS_RYUK_DISABLED=true` is the single switch that turns it off —
 * which is exactly the switch a developer reaches for when Docker feels slow,
 * trading a second of reaper boot for containers that outlive every run on the
 * machine.
 *
 * So the switch is refused for local runs. CI may set it: a runner is a fresh
 * VM destroyed when the job ends, so its containers die with the box whatever
 * the reaper does.
 *
 * Ryuk being on is necessary and NOT sufficient — measured on 2026-08-02, a
 * SIGKILLed client's container was still running 60s later with a healthy
 * reaper attached, because `getReaper()` REUSES the newest running reaper and
 * adopts its session id, so every test process on the box shares one reaper
 * and one death pact. That pact fires when the LAST client disconnects, not
 * when one dies. `remove-stale-testcontainers.ts` is the half that does not
 * depend on anyone else's process exiting.
 */

/** Testcontainers' own switch for the Ryuk reaper. */
export const TESTCONTAINERS_RYUK_DISABLED = "TESTCONTAINERS_RYUK_DISABLED";

/** The value testcontainers compares against — an exact string, not truthiness. */
const DISABLED = "true";

/**
 * Refuse a local run whose container cleanup was switched off.
 *
 * Reads the switch exactly as testcontainers reads it, so this wall and the
 * library can never disagree about whether the reaper is running.
 */
export function refuseDisabledContainerCleanup(env: Readonly<Record<string, string | undefined>>): void {
  if (env[TESTCONTAINERS_RYUK_DISABLED] !== DISABLED) return;
  if (env["CI"] !== undefined) return;

  throw new Error(
    `${TESTCONTAINERS_RYUK_DISABLED}=${DISABLED} is refused for local runs. Ryuk is the ` +
      `only cleanup that survives a killed test process; without it this run's ` +
      `containers outlive it and stay on the machine forever. CI sets this ` +
      `variable freely — its runners are destroyed with their containers.`,
  );
}
