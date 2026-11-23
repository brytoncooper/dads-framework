import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { hasCode } from "./process-inspection.js";

export const slotSchema = z.strictObject({
  worktree: z.string(),
  id: z.string().regex(/^[0-9a-f]{24}$/),
  firstPort: z.number().int().positive(),
  portCount: z.number().int().positive(),
  lastUsed: z.number(),
});
export type Slot = z.infer<typeof slotSchema>;

export async function withSlotLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "lock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error("The slot registry is busy.", { cause: error });
      await setTimeout(100);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function readSlots(root: string): Promise<Slot[]> {
  const value = await readJson(join(root, "slots.json"));
  return value === undefined ? [] : z.array(slotSchema).parse(value);
}

export async function writeSlots(root: string, slots: readonly Slot[]): Promise<void> {
  await writeJson(join(root, "slots.json"), slots);
}

export function slotDirectory(root: string, slot: Slot): string {
  return join(root, slot.id);
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
