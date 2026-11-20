import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  type DockerContainerClient,
  type TestcontainersContainer,
  describeRemovedTestcontainers,
  selectStaleTestcontainers,
  removeStaleTestcontainers,
} from "./remove-stale-testcontainers.js";

const NOW = new Date("2026-08-02T21:00:00.000Z");

/** A running container the harness started, `minutes` ago, in `sessionId`. */
function aged(
  id: string,
  minutes: number,
  sessionId: string,
  isReaper = false,
): TestcontainersContainer {
  return {
    id,
    image: isReaper ? "testcontainers/ryuk:0.14.0" : "postgres:16-alpine",
    sessionId,
    isReaper,
    running: true,
    createdAt: new Date(NOW.getTime() - minutes * 60_000),
  };
}

/** The same, but stopped — exited, or created and never started. */
function stopped(
  id: string,
  minutes: number,
  sessionId: string,
  isReaper = false,
): TestcontainersContainer {
  return { ...aged(id, minutes, sessionId, isReaper), running: false };
}

/** Docker, faked: records what the sweep asked it to remove. */
function fakeDocker(
  containers: readonly TestcontainersContainer[],
  failOn: readonly string[] = [],
): DockerContainerClient & { readonly removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    listTestcontainersContainers: () => Promise.resolve(containers),
    remove: (id: string) => {
      if (failOn.includes(id)) {
        return Promise.reject(new Error(`docker rm ${id}: no such container`));
      }
      removed.push(id);
      return Promise.resolve();
    },
  };
}

describe("selectStaleTestcontainers", () => {
  it("sweeps an aged container whose session has no reaper left alive", () => {
    // The exact shape of the leak: containers labelled with a session whose
    // reaper was already gone, so nothing would ever remove them.
    const corpse = aged("corpse", 40, "dead-session");
    expect(selectStaleTestcontainers([corpse], NOW).map((c) => c.id)).toEqual([
      "corpse",
    ]);
  });

  it("spares a container younger than the age floor", () => {
    expect(
      selectStaleTestcontainers([aged("young", 5, "dead-session")], NOW),
    ).toEqual([]);
  });

  it("spares the session this run is about to adopt", () => {
    // `getReaper()` reuses the newest running reaper and adopts its session id,
    // so a concurrent lane's containers usually carry the very session id this
    // run is about to call its own. Sparing that session is what makes the
    // sweep safe to run while another lane is mid-suite.
    const reaper = aged("reaper", 30, "live-session", true);
    const inUse = aged("in-use", 25, "live-session");
    expect(selectStaleTestcontainers([reaper, inUse], NOW)).toEqual([]);
  });

  it("never removes a RUNNING reaper, however old", () => {
    // Removing another lane's reaper would orphan every container it watches —
    // the sweep would manufacture exactly the corpses it exists to clear.
    expect(
      selectStaleTestcontainers([aged("old-reaper", 600, "some", true)], NOW),
    ).toEqual([]);
  });

  it("sweeps every aged container when no reaper is running at all", () => {
    // No running reaper means this run will create a fresh one with a session
    // id no existing container can carry, so every aged container is a corpse.
    const containers = [
      aged("a", 20, "session-one"),
      aged("b", 90, "session-two"),
      aged("c", 2, "session-two"),
    ];
    expect(selectStaleTestcontainers(containers, NOW).map((c) => c.id)).toEqual(
      ["a", "b"],
    );
  });

  it("adopts the NEWEST running reaper's session, as testcontainers does", () => {
    // testcontainers lists RUNNING reapers, sorts newest first, and takes the
    // first that accepts a socket. Reading "current session" any other way
    // would spare the wrong lane and sweep a live one.
    const older = aged("older-reaper", 90, "older-session", true);
    const newer = aged("newer-reaper", 30, "newer-session", true);
    const onOlder = aged("on-older", 80, "older-session");
    const onNewer = aged("on-newer", 25, "newer-session");
    const stale = selectStaleTestcontainers(
      [older, newer, onOlder, onNewer],
      NOW,
    );
    expect(stale.map((c) => c.id)).toEqual(["on-older"]);
  });

  it("ignores a stopped reaper when deciding which session is current", () => {
    // A stopped reaper watches nothing, so testcontainers will not reuse it and
    // neither may the sweep — treating its session as current would spare a
    // whole generation of corpses forever.
    const deadReaper = stopped("dead-reaper", 90, "dead-session", true);
    const orphan = aged("orphan", 80, "dead-session");
    const stale = selectStaleTestcontainers([deadReaper, orphan], NOW);
    expect(stale.map((c) => c.id)).toEqual(["dead-reaper", "orphan"]);
  });

  it("sweeps aged containers that are not running, whatever their session", () => {
    // Found on the real box: 70 harness containers present and 0 running —
    // exited (137) after a reaper stopped them, plus some Docker was too
    // saturated to ever start. `docker ps` cannot see them, so nothing removed
    // them and they sat on the disk. A container that is not running cannot
    // belong to a live suite, so past the age floor it is garbage even when it
    // carries the session this run is about to adopt.
    const reaper = aged("reaper", 30, "live-session", true);
    const exited = stopped("exited", 40, "live-session");
    const created = stopped("created", 40, "live-session");
    const runningInUse = aged("in-use", 25, "live-session");
    const stale = selectStaleTestcontainers(
      [reaper, exited, created, runningInUse],
      NOW,
    );
    expect(stale.map((c) => c.id)).toEqual(["exited", "created"]);
  });

  it("still spares a stopped container younger than the floor", () => {
    // A container created seconds ago is one a run is starting right now.
    expect(
      selectStaleTestcontainers([stopped("starting", 1, "live")], NOW),
    ).toEqual([]);
  });

  it("uses 15 minutes as the floor", () => {
    expect(STALE_AFTER_MS).toBe(15 * 60_000);
    expect(
      selectStaleTestcontainers([aged("just-under", 14, "s")], NOW),
    ).toEqual([]);
    expect(
      selectStaleTestcontainers([aged("just-over", 16, "s")], NOW).map(
        (c) => c.id,
      ),
    ).toEqual(["just-over"]);
  });
});

describe("removeStaleTestcontainers", () => {
  it("removes what it selected and reports the count", async () => {
    const docker = fakeDocker([
      aged("corpse-one", 40, "dead"),
      aged("corpse-two", 40, "dead"),
      aged("young", 1, "dead"),
    ]);
    const report = await removeStaleTestcontainers(docker, NOW);
    expect(docker.removed).toEqual(["corpse-one", "corpse-two"]);
    expect(report.removed).toBe(2);
    expect(report.sessions).toEqual(["dead"]);
  });

  it("keeps going when docker refuses one container", async () => {
    // A container that vanished between the list and the remove is the normal
    // race, not a reason to abandon the rest of the sweep or fail the run.
    const docker = fakeDocker(
      [aged("gone", 40, "dead"), aged("still-there", 40, "dead")],
      ["gone"],
    );
    const report = await removeStaleTestcontainers(docker, NOW);
    expect(docker.removed).toEqual(["still-there"]);
    expect(report.removed).toBe(1);
    expect(report.failed).toBe(1);
  });

  it("never throws when docker itself is unreachable", async () => {
    // The sweep is housekeeping. A machine without a running Docker must still
    // be able to run the tests that do not need one.
    const broken: DockerContainerClient = {
      listTestcontainersContainers: () =>
        Promise.reject(new Error("Cannot connect to the Docker daemon")),
      remove: () => Promise.resolve(),
    };
    const report = await removeStaleTestcontainers(broken, NOW);
    expect(report.removed).toBe(0);
    expect(report.unavailable).toBe(true);
  });
});

describe("describeRemovedTestcontainers", () => {
  it("says nothing when there was nothing to sweep", () => {
    expect(
      describeRemovedTestcontainers({
        removed: 0,
        failed: 0,
        sessions: [],
        unavailable: false,
      }),
    ).toBeNull();
  });

  it("names the count and the sessions it cleared, on one line", () => {
    const line = describeRemovedTestcontainers({
      removed: 46,
      failed: 1,
      sessions: ["2b57c3aa3df3", "9f01ab"],
      unavailable: false,
    });
    expect(line).not.toBeNull();
    expect(line).not.toContain("\n");
    expect(line).toContain("46");
    expect(line).toContain("2b57c3aa3df3");
    expect(line).toContain("9f01ab");
  });
});
