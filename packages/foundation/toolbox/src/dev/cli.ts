import { access } from "node:fs/promises";
import { join } from "node:path";
import { readDevConfig } from "./dev-config.js";
import { findRepository } from "./git-worktrees.js";
import { childFinished, launch } from "./managed-processes.js";
import { hasCode } from "./process-inspection.js";
import { prepareSlot, reserveSlot } from "./slot-environment.js";
import { runStatus, startSlot, stopSlot } from "./slot-run.js";
import { readSlots, slotDirectory, withSlotLock } from "./slot-state.js";
import { cleanupWorktrees, scratchWorktree } from "./worktree-lifecycle.js";

const HELP = "Usage: dad-dev up|down|status|ready|scratch|sweep|prune\n";

export async function runDevCommand(argv: readonly string[]): Promise<string> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help") return HELP;
  const { worktree, sharedGitDir } = await findRepository(process.cwd());
  const root = join(sharedGitDir, "dads-dev");
  switch (command) {
    case "scratch":
      await runScratch(worktree, root, args);
      return "";
    case "sweep":
    case "prune":
      return withSlotLock(root, async () =>
        json(await cleanupWorktrees(worktree, root, command === "prune", requestedBase(args))),
      );
    case "status":
      validateEmpty(args);
      return json(await describeSlots(root, worktree));
    case "up":
    case "ready":
      validateEmpty(args);
      return withSlotLock(root, () => bringUp(root, worktree, command));
    case "down":
      validateEmpty(args);
      return withSlotLock(root, () => bringDown(root, worktree));
    default:
      throw new Error(HELP.trimEnd());
  }
}

async function bringUp(root: string, worktree: string, command: "up" | "ready"): Promise<string> {
  const config = await readDevConfig(worktree);
  const slot = await reserveSlot(root, worktree, config);
  if ((await runStatus(slotDirectory(root, slot))) !== "running") {
    await prepareSlot(root, slot);
    if (command === "ready") await installLocalServiceDependencies(worktree, slotDirectory(root, slot));
    if (command === "up") await startSlot(root, slot, config);
  }
  return json(await describeSlots(root, worktree));
}

async function bringDown(root: string, worktree: string): Promise<string> {
  const slot = (await readSlots(root)).find((candidate) => candidate.worktree === worktree);
  if (slot !== undefined) await stopSlot(root, slot);
  return json(await describeSlots(root, worktree));
}

async function installLocalServiceDependencies(worktree: string, state: string): Promise<void> {
  try {
    await access(join(worktree, "package-lock.json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const child = launch(["npm", "ci"], worktree, process.env, join(state, "install.log"));
  if ((await childFinished(child)) !== 0) throw new Error(`Dependency installation failed. See ${state}/install.log.`);
}

async function describeSlots(root: string, worktree: string) {
  const slots = await readSlots(root);
  return Promise.all(
    slots.map(async (slot) => {
      const directory = slotDirectory(root, slot);
      return {
        worktree: slot.worktree,
        current: slot.worktree === worktree,
        state: await runStatus(directory),
        firstPort: slot.firstPort,
        portCount: slot.portCount,
        fileRoot: join(directory, "files"),
        database: `dads_${slot.id}`,
        environmentFile: join(directory, "environment.json"),
        urls: await serviceUrls(slot.worktree, slot.firstPort),
      };
    }),
  );
}

async function serviceUrls(worktree: string, firstPort: number) {
  try {
    const config = await readDevConfig(worktree);
    return Object.fromEntries(
      config.services.map((service) => [service.name, `http://127.0.0.1:${firstPort + service.portOffset}`]),
    );
  } catch {
    return {};
  }
}

function requestedBase(args: readonly string[]): string {
  if (args.length === 0) return "origin/main";
  const [option, base] = args;
  if (args.length === 2 && option === "--base" && base !== undefined && !base.startsWith("-")) return base;
  throw new Error("Use --base followed by a Git revision.");
}

async function runScratch(cwd: string, stateRoot: string, args: readonly string[]): Promise<void> {
  const [separator, command, ...rest] = args;
  if (separator !== "--" || command === undefined) throw new Error("Use scratch -- <command> [arguments].");
  await scratchWorktree(cwd, stateRoot, "HEAD", [command, ...rest]);
}

function validateEmpty(args: readonly string[]): void {
  if (args.length > 0) throw new Error("This command takes no arguments.");
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
