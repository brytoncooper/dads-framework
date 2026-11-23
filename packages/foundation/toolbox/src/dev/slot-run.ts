import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DevConfig } from "./dev-config.js";
import { childFinished, launch } from "./managed-processes.js";
import { slotPortsAvailable } from "./slot-environment.js";
import { hasCode, pidIsAlive } from "./process-inspection.js";
import { readJson, slotDirectory, writeJson, type Slot } from "./slot-state.js";

const runRefSchema = z.strictObject({
  directory: z.string().min(1),
  pid: z.number().int().positive(),
});
const stateSchema = z.enum(["starting", "running", "stopped", "failed"]);
type RunState = z.infer<typeof stateSchema>;

export async function runStatus(directory: string): Promise<RunState> {
  const active = await runRef(directory);
  if (active === undefined) return "stopped";
  const state = stateSchema.parse((await readJson(join(active.directory, "status.json"))) ?? "starting");
  if ((state === "running" || state === "starting") && !pidIsAlive(active.pid)) return "failed";
  return state;
}

export async function lastRunActivity(directory: string): Promise<number> {
  const active = await runRef(directory);
  if (active === undefined) return 0;
  try {
    return (await stat(join(active.directory, "status.json"))).mtimeMs;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

export async function startSlot(root: string, slot: Slot, config: DevConfig): Promise<void> {
  const directory = slotDirectory(root, slot);
  const current = await runStatus(directory);
  if (current === "running") return;
  if (current === "starting") throw new Error("A supervisor is already starting this slot.");
  if (!(await slotPortsAvailable(slot.firstPort, slot.portCount))) {
    throw new Error("The reserved port block is currently in use.");
  }
  const run = await mkdtemp(join(directory, "run-"));
  await writeJson(join(run, "plan.json"), { config, slot });
  const supervisor = fileURLToPath(new URL("./slot-supervisor.js", import.meta.url));
  const child = launch([process.execPath, supervisor, run], slot.worktree, process.env, join(run, "supervisor.log"));
  const exited = childFinished(child).catch(() => null);
  if (child.pid === undefined) {
    await exited;
    throw new Error("Could not start the slot supervisor.");
  }
  await writeJson(join(directory, "active.json"), {
    directory: run,
    pid: child.pid,
  });
  child.unref();
  const status = await pollStatus(directory, (state) => state !== "starting", 45_000);
  if (status !== "running") {
    await writeJson(join(run, "stop.json"), true);
    throw new Error(`Slot did not become ready. See ${run}/supervisor.log.`);
  }
}

export async function stopSlot(root: string, slot: Slot): Promise<void> {
  const directory = slotDirectory(root, slot);
  const active = await runRef(directory);
  if (active === undefined || !pidIsAlive(active.pid)) return;
  await writeJson(join(active.directory, "stop.json"), true);
  const status = await pollStatus(directory, (state) => state === "stopped" || state === "failed", 15_000);
  if (status !== "stopped" && status !== "failed") throw new Error("Slot supervisor did not stop before the deadline.");
}

async function runRef(directory: string): Promise<z.infer<typeof runRefSchema> | undefined> {
  const value = await readJson(join(directory, "active.json"));
  return value === undefined ? undefined : runRefSchema.parse(value);
}

async function pollStatus(directory: string, done: (state: RunState) => boolean, timeout: number): Promise<RunState> {
  const deadline = Date.now() + timeout;
  let state = await runStatus(directory);
  while (!done(state) && Date.now() < deadline) {
    await setTimeout(100);
    state = await runStatus(directory);
  }
  return state;
}
