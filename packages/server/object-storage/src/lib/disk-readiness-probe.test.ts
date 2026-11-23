import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskReadinessProbe } from "./disk-readiness-probe.js";
import { NODE_SWEEP_FILE_SYSTEM, type SweepFileSystem } from "./stale-temp-files.js";

type Logged = { readonly fields: Record<string, unknown> };

const now = new Date("2026-11-16T12:00:00Z");
const elevenMinutesAgo = new Date(now.getTime() - 11 * 60_000);

let root: string;
let logged: Logged[];

function denied(path: string): Error {
  return Object.assign(new Error(`EACCES: permission denied, ${path}`), {
    code: "EACCES",
  });
}

/** Node's calls, except listing `lockedFolder` and removing `stuckFile` are refused. */
function refusing(lockedFolder: string, stuckFile: string): SweepFileSystem {
  return {
    readdir: (folder) =>
      folder === lockedFolder ? Promise.reject(denied(folder)) : NODE_SWEEP_FILE_SYSTEM.readdir(folder),
    stat: NODE_SWEEP_FILE_SYSTEM.stat,
    rm: (path) => (path === stuckFile ? Promise.reject(denied(path)) : NODE_SWEEP_FILE_SYSTEM.rm(path)),
  };
}

async function staleFile(path: string): Promise<void> {
  await writeFile(path, "half");
  await utimes(path, elevenMinutesAgo, elevenMinutesAgo);
}

function probe(sweepFileSystem?: SweepFileSystem): DiskReadinessProbe {
  return new DiskReadinessProbe({
    rootDirectory: root,
    clock: () => now,
    log: {
      warn: (fields) => {
        logged.push({ fields });
      },
    },
    ...(sweepFileSystem === undefined ? {} : { sweepFileSystem }),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "readiness-probe-"));
  logged = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DiskReadinessProbe", () => {
  it("passes readiness and sweeps every other stale temp file when a folder cannot be listed and a file cannot be removed", async () => {
    const locked = join(root, "objects", "locked");
    const open = join(root, "objects", "open");
    await mkdir(locked, { recursive: true });
    await mkdir(open, { recursive: true });
    const stuck = join(open, "a.png.tmp-stuck");
    await staleFile(stuck);
    await staleFile(join(open, "b.png.tmp-stale"));
    await staleFile(join(root, "signing-key.tmp-stale"));

    await expect(probe(refusing(locked, stuck)).run()).resolves.toBeUndefined();

    await expect(readdir(open)).resolves.toEqual(["a.png.tmp-stuck"]);
    await expect(readdir(root)).resolves.toEqual(["objects"]);
    const [swept, failed] = logged.map((line) => line.fields);
    expect(swept).toEqual({ event: "site.files.temp_swept", removed: 2 });
    expect(failed?.["event"]).toBe("site.files.temp_sweep_failed");
    expect(failed?.["failed"]).toBe(2);
    expect(["objects/locked", "objects/open/a.png.tmp-stuck"]).toContain(failed?.["sample"]);
    expect(logged).toHaveLength(2);
  });

  it("sweeps once per process even when it could not remove everything, and the write probe alone decides readiness after", async () => {
    const stuck = join(root, "a.tmp-stuck");
    await staleFile(stuck);
    const readiness = probe(refusing(join(root, "none"), stuck));

    await readiness.run();
    await staleFile(join(root, "b.tmp-later"));
    await readiness.run();

    await expect(readdir(root)).resolves.toEqual(expect.arrayContaining(["a.tmp-stuck", "b.tmp-later"]));
    expect(logged.filter((line) => line.fields["event"] === "site.files.temp_sweep_failed")).toHaveLength(1);
  });
});
