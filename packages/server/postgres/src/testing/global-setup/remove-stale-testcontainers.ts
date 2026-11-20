import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The preflight sweep: every run clears its predecessors' corpses.
 *
 * Ryuk cannot be the whole answer. `getReaper()` reuses the newest running
 * reaper and adopts its session id, so every test process on the machine
 * collapses onto ONE reaper holding ONE death pact — and that pact fires when
 * the LAST client disconnects, not when one dies. Measured on 2026-08-02 with
 * two lanes testing continuously: a SIGKILLed client's container was still
 * running 60s later with a healthy reaper attached to its exact session. Worse,
 * when a reaper generation dies without reaping (a `docker rm -f`, a Docker
 * Desktop restart), everything it watched becomes unwatchable — 46 of the 83
 * containers on the box carried a session whose reaper was already gone, and
 * nothing in the world would ever have removed them.
 *
 * So cleanup cannot depend on anyone else's process exiting. It runs at the
 * START of a run, where the only thing that has to work is this run. Nothing
 * leaks permanently: the next container-tier run sweeps it.
 *
 * WHAT IT WILL REMOVE: containers carrying testcontainers' own harness label,
 * started more than 15 minutes ago, whose session id is not the one this run
 * is about to adopt.
 *
 * WHAT IT WILL NEVER REMOVE: reaper containers (removing another lane's reaper
 * would orphan everything it watches — manufacturing the exact corpses this
 * sweep exists to clear); anything younger than 15 minutes; anything carrying
 * the session id this run will adopt, which is how a concurrent lane's live
 * containers are spared, since reaper reuse means concurrent lanes normally
 * share one session id; and anything the harness did not start, which is
 * everything without the label — `docker compose` services included.
 */

/** The label testcontainers puts on every container it starts. */
const HARNESS_LABEL = "org.testcontainers=true";
const SESSION_LABEL = "org.testcontainers.session-id";
const REAPER_LABEL = "org.testcontainers.ryuk";

/** Go templates render an absent label as this. */
const ABSENT = "<no value>";

/** How old a container must be before the sweep will treat it as a corpse. */
export const STALE_AFTER_MS = 15 * 60_000;

/** A harness-started container, as the sweep needs to see it. */
export type TestcontainersContainer = {
  readonly id: string;
  readonly image: string;
  readonly sessionId: string;
  readonly isReaper: boolean;
  /** Stopped containers are corpses too, and `docker ps` cannot see them. */
  readonly running: boolean;
  /** Creation, not start: a container that never started still has an age. */
  readonly createdAt: Date;
};

/** The Docker calls the sweep makes — a port, so the logic tests against a fake. */
export type DockerContainerClient = {
  listTestcontainersContainers: () => Promise<
    readonly TestcontainersContainer[]
  >;
  remove: (id: string) => Promise<void>;
};

export type RemovedTestcontainersReport = {
  readonly removed: number;
  readonly failed: number;
  readonly sessions: readonly string[];
  readonly unavailable: boolean;
};

/**
 * The session id this run will end up using.
 *
 * Not a guess: `getReaper()` lists running reaper containers, sorts them newest
 * first, and adopts the session id of the first one that accepts a socket. Read
 * the same way here, so "not the current session" means the same thing to the
 * sweep as it does to the library.
 */
function sessionThisRunWillAdopt(
  containers: readonly TestcontainersContainer[],
): string | null {
  const reapers = containers
    // RUNNING reapers only, exactly as `findReaperContainers` filters. A
    // stopped reaper watches nothing and will not be reused, so treating its
    // session as current would spare a whole generation of corpses forever.
    .filter((container) => container.isReaper && container.running)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return reapers[0]?.sessionId ?? null;
}

/** Pure: which of these containers are corpses? */
export function selectStaleTestcontainers(
  containers: readonly TestcontainersContainer[],
  now: Date,
): readonly TestcontainersContainer[] {
  const adopted = sessionThisRunWillAdopt(containers);
  return containers.filter((container) => {
    if (now.getTime() - container.createdAt.getTime() <= STALE_AFTER_MS) {
      return false;
    }
    // A container that is not running cannot belong to a live suite, so past
    // the age floor it is garbage whatever its session — including a stopped
    // reaper, and including the session this run is about to adopt.
    if (!container.running) return true;
    return !container.isReaper && container.sessionId !== adopted;
  });
}

/** Remove the corpses. Never throws: housekeeping does not fail a test run. */
export async function removeStaleTestcontainers(
  client: DockerContainerClient,
  now: Date,
): Promise<RemovedTestcontainersReport> {
  let containers: readonly TestcontainersContainer[];
  try {
    containers = await client.listTestcontainersContainers();
  } catch {
    return { removed: 0, failed: 0, sessions: [], unavailable: true };
  }

  const stale = selectStaleTestcontainers(containers, now);
  let removed = 0;
  let failed = 0;
  const sessions = new Set<string>();

  for (const container of stale) {
    try {
      await client.remove(container.id);
      removed += 1;
      sessions.add(container.sessionId);
    } catch {
      // Vanished between the list and the remove — the normal race, and no
      // reason to abandon the rest of the sweep.
      failed += 1;
    }
  }

  return { removed, failed, sessions: [...sessions], unavailable: false };
}

/** The one line a sweep is worth, or nothing at all when it found nothing. */
export function describeRemovedTestcontainers(
  report: RemovedTestcontainersReport,
): string | null {
  if (report.removed === 0) return null;
  const failed = report.failed > 0 ? `, ${report.failed} already gone` : "";
  return (
    `[test-harness] swept ${report.removed} stale container(s) older than ` +
    `15m from dead session(s) ${report.sessions.join(", ")}${failed}`
  );
}

/** The real Docker, driven through its CLI so the harness gains no dependency. */
export function dockerCli(): DockerContainerClient {
  return {
    listTestcontainersContainers: async () => {
      // `--all`, not just running. Exited and never-started containers hold
      // their disk and their name, and `docker ps` cannot see them — which is
      // how 70 of them accumulated unnoticed on one machine.
      const { stdout: ids } = await run("docker", [
        "ps",
        "--all",
        "--filter",
        `label=${HARNESS_LABEL}`,
        "--format",
        "{{.ID}}",
      ]);
      const found = ids.split("\n").filter((line) => line.trim() !== "");
      if (found.length === 0) return [];

      const { stdout } = await run("docker", [
        "inspect",
        ...found,
        "--format",
        `{{.Id}}\t{{.Config.Image}}\t{{.Created}}\t{{.State.Running}}\t` +
          `{{index .Config.Labels "${SESSION_LABEL}"}}\t` +
          `{{index .Config.Labels "${REAPER_LABEL}"}}`,
      ]);
      return stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(parseInspectLine)
        .filter(
          (container): container is TestcontainersContainer =>
            container !== null,
        );
    },
    remove: async (id: string) => {
      // `--volumes` because a leaked container's anonymous volume leaks with
      // it, and disk is the other half of what saturates the machine.
      await run("docker", ["rm", "--force", "--volumes", id]);
    },
  };
}

function parseInspectLine(line: string): TestcontainersContainer | null {
  const [id, image, createdAt, running, sessionId, reaper] = line.split("\t");
  if (id === undefined || sessionId === undefined || sessionId === ABSENT) {
    return null;
  }
  const created = new Date(createdAt ?? "");
  if (Number.isNaN(created.getTime())) return null;
  return {
    id,
    image: image ?? "",
    sessionId,
    isReaper: reaper === "true",
    running: running === "true",
    createdAt: created,
  };
}
