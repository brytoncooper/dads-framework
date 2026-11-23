const REDACTED_MARKER = "[REDACTED]";
const CIRCULAR_MARKER = "[CIRCULAR]";

const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "privatekey",
  "credential",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redactMap(map: Map<unknown, unknown>, ancestors: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of map.entries()) {
    const keyText = String(key);
    result[keyText] = isSensitiveKey(keyText) ? REDACTED_MARKER : redactNode(entryValue, ancestors);
  }
  return result;
}

function redactRecord(record: object, ancestors: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    result[key] = isSensitiveKey(key) ? REDACTED_MARKER : redactNode(entryValue, ancestors);
  }
  return result;
}

function redactObject(value: object, ancestors: WeakSet<object>): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (ancestors.has(value)) {
    return CIRCULAR_MARKER;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactNode(item, ancestors));
    }
    if (value instanceof Set) {
      return [...value].map((item) => redactNode(item, ancestors));
    }
    if (value instanceof Map) {
      return redactMap(value, ancestors);
    }
    return redactRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function redactNode(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  return redactObject(value, ancestors);
}

/**
 * Recursively redact sensitive fields from an action's input before recording it
 * in the audit run store.
 *
 * When a custom redactor is provided, it runs first and the standard sensitive
 * key redaction still runs on its result as defense in depth.
 */
export function redactActionInput<TInput>(value: TInput, customRedactor?: (input: TInput) => unknown): unknown {
  const base: unknown = customRedactor === undefined ? value : customRedactor(value);
  return redactNode(base, new WeakSet<object>());
}
