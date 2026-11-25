import { isRecord } from "./parse-guards.js";

export type TestingManifestTaskBatchMode = "args" | "vitest-files";

export type TestingManifestTaskBatch = {
  readonly maxSize: number;
  readonly groupKey?: string;
  readonly sharedArgs?: number;
  readonly mode?: TestingManifestTaskBatchMode;
};

const taskBatchModes: readonly TestingManifestTaskBatchMode[] = ["args", "vitest-files"];

export function readTaskBatch(value: unknown, where: string, subject: string): TestingManifestTaskBatch {
  if (!isRecord(value)) {
    throw new Error(`${subject}: ${where} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!["maxSize", "groupKey", "sharedArgs", "mode"].includes(key)) {
      throw new Error(`${subject}: unknown key "${key}" in ${where}`);
    }
  }
  const maxSize = readBatchMaxSize(value["maxSize"], where, subject);
  const groupKey = readBatchOptionalString(value["groupKey"], `${where}.groupKey`, subject);
  const sharedArgs = readOptionalSharedArgs(value["sharedArgs"], where, subject);
  const mode = readOptionalBatchMode(value["mode"], `${where}.mode`, subject);
  return {
    maxSize,
    ...(groupKey === undefined ? {} : { groupKey }),
    ...(sharedArgs === undefined ? {} : { sharedArgs }),
    ...(mode === undefined ? {} : { mode }),
  };
}

export function serializeTaskBatch(batch: TestingManifestTaskBatch): TestingManifestTaskBatch {
  return {
    maxSize: batch.maxSize,
    ...(batch.groupKey === undefined ? {} : { groupKey: batch.groupKey }),
    ...(batch.sharedArgs === undefined ? {} : { sharedArgs: batch.sharedArgs }),
    ...(batch.mode === undefined ? {} : { mode: batch.mode }),
  };
}

function readBatchMaxSize(value: unknown, where: string, subject: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
    throw new Error(`${subject}: ${where}.maxSize must be an integer >= 2`);
  }
  return value;
}

function readOptionalSharedArgs(value: unknown, where: string, subject: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${subject}: ${where}.sharedArgs must be a non-negative integer`);
  }
  return value;
}

function readBatchOptionalString(value: unknown, where: string, subject: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${subject}: ${where} must be a string`);
  }
  return value;
}

function readOptionalBatchMode(
  value: unknown,
  where: string,
  subject: string,
): TestingManifestTaskBatchMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${subject}: ${where} must be a string`);
  }
  const match = taskBatchModes.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`${subject}: ${where} must be one of ${taskBatchModes.join(", ")}`);
  }
  return match;
}
