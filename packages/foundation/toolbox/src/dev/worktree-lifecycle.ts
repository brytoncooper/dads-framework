import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitWorktrees, isDirty, type GitWorktree } from "./git-worktrees.js";
import { childFinished, launch, stopProcesses } from "./managed-processes.js";
import { worktreeHasProcesses } from "./process-inspection.js";
import { lastRunActivity, runStatus } from "./slot-run.js";
import { readSlots, slotDirectory, withSlotLock, writeSlots, type Slot } from "./slot-state.js";
import { decideWorktreeRemoval } from "./worktree-decision.js";

export async function cleanupWorktrees(cwd: string, stateRoot: string, apply: boolean, base: string) {
  const baseCommit = await git(cwd, ["rev-parse", "--verify", `${base}^{commit}`]);
  const slots = await readSlots(stateRoot);
  const outcomes: {
    path: string;
    remove: boolean;
    removed: boolean;
    reason: string;
  }[] = [];
  for (const checkout of await gitWorktrees(cwd)) {
    const slot = slots.find(({ worktree }) => worktree === checkout.path);
    const decision =
      checkout.path === cwd
        ? { remove: false, reason: "current" }
        : await evaluate(checkout, stateRoot, slot, baseCommit);
    const removed = apply && decision.remove && (await removeIfStillSafe(cwd, checkout, stateRoot, slot, baseCommit));
    outcomes.push({ path: checkout.path, ...decision, removed });
  }
  if (apply) {
    await writeSlots(
      stateRoot,
      slots.filter((slot) => !outcomes.some((outcome) => outcome.removed && outcome.path === slot.worktree)),
    );
  }
  return outcomes;
}

async function removeIfStillSafe(
  cwd: string,
  prior: GitWorktree,
  stateRoot: string,
  slot: Slot | undefined,
  base: string,
): Promise<boolean> {
  const current = (await gitWorktrees(cwd)).find(({ path }) => path === prior.path);
  if (current === undefined || current.head !== prior.head) return false;
  if (!(await evaluate(current, stateRoot, slot, base)).remove) return false;
  try {
    await git(cwd, ["worktree", "remove", "--", current.path]);
    return true;
  } catch {
    return false;
  }
}

async function evaluate(checkout: GitWorktree, stateRoot: string, slot: Slot | undefined, base: string) {
  try {
    if (checkout.primary || checkout.locked) return { remove: false, reason: checkout.primary ? "primary" : "locked" };
    const [{ empty, mergedPatch }, pushed, dirty, idleMinutes] = await Promise.all([
      patchStatus(checkout, base),
      isPushed(checkout),
      isDirty(checkout.path),
      worktreeIdleMinutes(checkout.path, stateRoot, slot),
    ]);
    const running = await alreadyRunning(checkout.path, stateRoot, slot);
    return decideWorktreeRemoval({
      ...checkout,
      empty,
      mergedPatch,
      pushed,
      dirty,
      running,
      idleMinutes,
    });
  } catch {
    return { remove: false, reason: "unverified" };
  }
}

async function isPushed(checkout: GitWorktree): Promise<boolean> {
  return (
    (await git(checkout.path, ["for-each-ref", "--format=%(refname)", `--contains=${checkout.head}`, "refs/remotes"]))
      .length > 0
  );
}

async function patchStatus(checkout: GitWorktree, base: string) {
  const ahead = Number(await git(checkout.path, ["rev-list", "--count", `${base}..${checkout.head}`]));
  if (ahead === 0) return { empty: true, mergedPatch: false };
  const patches = (await git(checkout.path, ["cherry", base, checkout.head])).split("\n").filter(Boolean);
  return {
    empty: false,
    mergedPatch: patches.length === ahead && patches.every((patch) => patch.startsWith("- ")),
  };
}

async function alreadyRunning(path: string, stateRoot: string, slot: Slot | undefined): Promise<boolean> {
  if (slot !== undefined) {
    const status = await runStatus(slotDirectory(stateRoot, slot));
    if (status === "running" || status === "starting") return true;
  }
  return worktreeHasProcesses(path);
}

async function worktreeIdleMinutes(path: string, stateRoot: string, slot: Slot | undefined): Promise<number> {
  const directory = await git(path, ["rev-parse", "--absolute-git-dir"]);
  const timestamps = await Promise.all([stat(join(directory, "HEAD")), stat(join(directory, "index")), stat(path)]);
  const lastRun = slot === undefined ? 0 : await lastRunActivity(slotDirectory(stateRoot, slot));
  const lastActivity = Math.max(lastRun, slot?.lastUsed ?? 0, ...timestamps.map((entry) => entry.mtimeMs));
  return (Date.now() - lastActivity) / 60_000;
}

export async function scratchWorktree(
  cwd: string,
  stateRoot: string,
  base: string,
  command: readonly [string, ...string[]],
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "dads-scratch-"));
  const path = join(parent, "checkout");
  await git(cwd, ["worktree", "add", "--detach", "--lock", "--reason", "dad-dev scratch", "--", path, base]);
  let complete = false;
  try {
    await runScratchCommand(path, command, join(parent, "scratch.log"));
    complete = true;
  } finally {
    await withSlotLock(stateRoot, () => finishScratch(cwd, stateRoot, path, parent, complete));
  }
}

async function finishScratch(
  cwd: string,
  stateRoot: string,
  path: string,
  parent: string,
  complete: boolean,
): Promise<void> {
  const slots = await readSlots(stateRoot);
  const slot = slots.find((candidate) => candidate.worktree === path);
  const keep = (await isDirty(path)) || (await alreadyRunning(path, stateRoot, slot));
  await git(cwd, ["worktree", "unlock", "--", path]);
  if (keep) {
    process.stderr.write(`Kept scratch checkout ${path} because it has changes or running processes.\n`);
    return;
  }
  await git(cwd, ["worktree", "remove", "--", path]);
  if (slot !== undefined)
    await writeSlots(
      stateRoot,
      slots.filter((candidate) => candidate !== slot),
    );
  if (complete) await rm(parent, { recursive: true });
  process.stdout.write(`Removed scratch checkout ${path}.\n`);
}

async function runScratchCommand(
  path: string,
  command: readonly [string, ...string[]],
  logFile: string,
): Promise<void> {
  const child = launch([...command], path, process.env, logFile);
  const interrupt = () => {
    void stopProcesses([child]).catch(() => undefined);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if ((await childFinished(child)) !== 0) {
      throw new Error(`Scratch command failed. See ${logFile}.`);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
