import { randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { TEMP_MARKER } from "./disk-files.js";
import { NODE_SWEEP_FILE_SYSTEM, removeStaleTempFiles, type SweepFileSystem } from "./stale-temp-files.js";

/** A temp file older than this cannot belong to a write still running. */
const STALE_TEMP_FILE_AGE_MS = 10 * 60_000;

type ReadinessProbeOptions = {
  readonly rootDirectory: string;
  readonly clock: () => Date;
  readonly log: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** The sweep's file-system calls; Node's own unless a test fails them. */
  readonly sweepFileSystem?: SweepFileSystem;
};

/**
 * The disk driver's write probe: writes, fsyncs and removes a file beside
 * `objects/`, so a full or read-only volume fails readiness. The first probe
 * in a process (boot) also removes the temp files a crash or power cut left
 * between a temp write and its rename, so they never slowly use the disk
 * under the floor.
 */
export class DiskReadinessProbe {
  private staleTempFilesSwept = false;

  constructor(private readonly options: ReadinessProbeOptions) {}

  async run(): Promise<void> {
    await mkdir(this.options.rootDirectory, { recursive: true });
    if (!this.staleTempFilesSwept) {
      // Once per process, whatever it managed: a leftover it cannot remove
      // is logged and waits for the next boot, never retried every probe.
      this.staleTempFilesSwept = true;
      await this.sweepStaleTempFiles();
    }
    const probe = join(this.options.rootDirectory, `readiness-probe${TEMP_MARKER}${randomBytes(6).toString("hex")}`);
    const handle = await open(probe, "wx");
    try {
      await handle.writeFile("ok");
      await handle.sync();
    } finally {
      await handle.close();
      await rm(probe, { force: true });
    }
  }

  /** Best effort: never rejects, so a cleanup chore never fails readiness. */
  private async sweepStaleTempFiles(): Promise<void> {
    const before = this.options.clock().getTime() - STALE_TEMP_FILE_AGE_MS;
    const sweep = await removeStaleTempFiles(
      this.options.rootDirectory,
      before,
      this.options.sweepFileSystem ?? NODE_SWEEP_FILE_SYSTEM,
    );
    if (sweep.removed > 0) {
      this.options.log.warn(
        { event: "site.files.temp_swept", removed: sweep.removed },
        "removed temp files a crash left behind",
      );
    }
    if (sweep.failed > 0) {
      this.options.log.warn(
        {
          event: "site.files.temp_sweep_failed",
          failed: sweep.failed,
          sample: sweep.failedSample,
        },
        "could not remove some temp files a crash left behind",
      );
    }
  }
}
