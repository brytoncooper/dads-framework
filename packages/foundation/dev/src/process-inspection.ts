import { execFile } from "node:child_process";
import { readlink, readdir, stat } from "node:fs/promises";
import { sep } from "node:path";
import { promisify } from "node:util";

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

/** Unknown visibility is treated as a running process. */
export async function worktreeHasProcesses(path: string): Promise<boolean> {
  try {
    return process.platform === "linux"
      ? await linuxHasProcesses(path)
      : await localUserHasProcesses(path);
  } catch {
    return true;
  }
}

async function linuxHasProcesses(path: string): Promise<boolean> {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const proc = `/proc/${entry}`;
      if ((await stat(proc)).uid !== process.getuid?.()) continue;
      if (inside(await readlink(`${proc}/cwd`), path)) return true;
    } catch (error) {
      if (!isUnavailableProcess(error)) throw error;
    }
  }
  return false;
}

function isUnavailableProcess(error: unknown): boolean {
  return ["ENOENT", "ESRCH", "EACCES", "EPERM"].some((code) =>
    hasCode(error, code),
  );
}

async function localUserHasProcesses(path: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  const execute = promisify(execFile);
  const result = await execute(
    "lsof",
    ["-a", "-u", String(uid), "-d", "cwd", "-Fn"],
    {
      encoding: "utf8",
      timeout: 8_000,
    },
  );
  return result.stdout
    .split("\n")
    .some((line) => line.startsWith("n") && inside(line.slice(1), path));
}

function inside(cwd: string, path: string): boolean {
  return cwd === path || cwd.startsWith(path + sep);
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
