import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import type { DevCommand } from "./dev-config.js";
import { hasCode, pidIsAlive } from "./process-inspection.js";

export function launch(command: DevCommand, cwd: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const [file, ...args] = command;
  const output = openSync(log, "a", 0o600);
  try {
    return spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", output, output],
    });
  } finally {
    closeSync(output);
  }
}

export function childFinished(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

export async function stopProcesses(children: readonly ChildProcess[]): Promise<void> {
  const running = children.flatMap((child) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return [];
    return [child.pid];
  });
  for (const pid of running) signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && running.some(pidIsAlive)) await setTimeout(50);
  for (const pid of running) {
    // Only target a surviving group while its original leader is still alive.
    if (children.some((child) => child.pid === pid && child.exitCode === null && child.signalCode === null)) {
      signalProcessGroup(pid, "SIGKILL");
    }
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}
