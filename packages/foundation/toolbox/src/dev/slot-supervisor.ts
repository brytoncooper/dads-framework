import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { devConfigSchema } from "./dev-config.js";
import { childFinished, launch, stopProcesses } from "./managed-processes.js";
import { readJson, slotSchema, writeJson } from "./slot-state.js";

const planSchema = z.strictObject({
  config: devConfigSchema,
  slot: slotSchema,
});
const environmentSchema = z.strictObject({
  HOST: z.literal("127.0.0.1"),
  PORT: z.string(),
  DATABASE_URL: z.string(),
  DADS_FILE_ROOT: z.string(),
});

type BootPlan = z.infer<typeof planSchema>;
type SlotEnvironment = z.infer<typeof environmentSchema>;

async function supervise(directory: string): Promise<void> {
  const status = join(directory, "status.json");
  const plan = planSchema.parse(await readJson(join(directory, "plan.json")));
  const environment = environmentSchema.parse(await readJson(join(dirname(directory), "environment.json")));
  const children: ChildProcess[] = [];
  const outcome = { failed: false };
  try {
    await bootServices(plan, environment, directory, children, outcome);
    await writeJson(status, "running");
    while (!outcome.failed && !(await stopRequested(directory))) await setTimeout(150);
  } catch (error) {
    outcome.failed = true;
    process.stderr.write(`Slot supervisor: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  } finally {
    const finalStatus = outcome.failed ? "failed" : "stopped";
    await stopProcesses(children);
    await writeJson(status, finalStatus);
  }
}

async function bootServices(
  { config, slot }: BootPlan,
  environment: SlotEnvironment,
  directory: string,
  children: ChildProcess[],
  outcome: { failed: boolean },
): Promise<void> {
  const deadline = Date.now() + 40_000;
  const stopped = () => stopRequested(directory);
  if (config.prepare !== undefined) {
    const child = launch(
      config.prepare,
      slot.worktree,
      { ...process.env, ...environment },
      join(directory, "prepare.log"),
    );
    children.push(child);
    await waitForPreparation(child, stopped, deadline);
  }
  const childStopped = () => {
    outcome.failed = true;
  };
  for (const service of config.services) {
    const port = slot.firstPort + service.portOffset;
    const child = launch(
      service.command,
      slot.worktree,
      { ...process.env, ...service.env, ...environment, PORT: String(port) },
      join(directory, `${service.name}.log`),
    );
    children.push(child);
    void childFinished(child).then(childStopped, childStopped);
    await waitForReady(port, service.readyPath, () => outcome.failed, stopped, deadline);
  }
}

async function waitForPreparation(
  child: ChildProcess,
  stopped: () => Promise<boolean>,
  deadline: number,
): Promise<void> {
  const completion: { done: boolean; code: number | null } = {
    done: false,
    code: null,
  };
  void childFinished(child).then(
    (code) => {
      completion.done = true;
      completion.code = code;
    },
    () => {
      completion.done = true;
    },
  );
  while (!completion.done && Date.now() < deadline && !(await stopped())) {
    await setTimeout(100);
  }
  if (completion.code !== 0) throw new Error("Slot preparation failed or timed out.");
}

async function stopRequested(directory: string): Promise<boolean> {
  return (await readJson(join(directory, "stop.json"))) === true;
}

async function waitForReady(
  port: number,
  path: string,
  failed: () => boolean,
  stopped: () => Promise<boolean>,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline && !failed() && !(await stopped())) {
    if (await healthy(port, path)) return;
    await setTimeout(150);
  }
  throw new Error(`Service on port ${port} did not become ready.`);
}

async function healthy(port: number, path: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing slot run directory.");
await supervise(directory);
