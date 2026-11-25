import { isRecord, isUnknownArray } from "./parse-guards.js";

export function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  where: string,
  subject: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowedKeys.includes(key)) continue;
    throw new Error(`${subject}: unknown key "${key}" in ${where}`);
  }
}

export function readRecord(value: unknown, where: string, subject: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${subject}: ${where} must be an object`);
  }
  return value;
}

export function readArray(value: unknown, where: string, subject: string): readonly unknown[] {
  if (!isUnknownArray(value)) {
    throw new Error(`${subject}: ${where} must be an array`);
  }
  return value;
}

export function readString(value: unknown, where: string, subject: string): string {
  if (typeof value !== "string") {
    throw new Error(`${subject}: ${where} must be a string`);
  }
  return value;
}

export function readStringArray(value: unknown, where: string, subject: string): readonly string[] {
  return readArray(value, where, subject).map((entry, index) =>
    readString(entry, `${where}[${String(index)}]`, subject),
  );
}

export function readOptionalStringArray(value: unknown, where: string, subject: string): readonly string[] {
  return value === undefined ? [] : readStringArray(value, where, subject);
}

export function readEnumeration<Value extends string>(
  value: unknown,
  allowedValues: readonly Value[],
  where: string,
  subject: string,
): Value {
  const text = readString(value, where, subject);
  const match = allowedValues.find((candidate) => candidate === text);
  if (match === undefined) {
    throw new Error(`${subject}: ${where} must be one of ${allowedValues.join(", ")}`);
  }
  return match;
}
