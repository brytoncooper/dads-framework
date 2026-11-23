import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../parse-guards.js";
import { baselineSectionOf } from "./doctor-gate.js";
import { compareStrings } from "./doctor-gate-model.js";
import type { DoctorSignal } from "./doctor-signal.js";
import { DOCTOR_SIGNALS } from "./doctor-signals.js";

export const RATCHET_POLICY_PATH = ".agents/source-ratchet.json";
const PROJECT_PATH = "dads.project.json";

const CODE_HEALTH_IDS = new Set([
  "explicit-any",
  "type-assertions",
  "non-null-assertions",
  "interface-type-mix",
  "files-over-ceiling",
  "test-files-over-ceiling",
  "functions-over-ceiling",
  "ts-suppressions",
  "suppressions-without-description",
]);

const CODE_HEALTH = DOCTOR_SIGNALS.filter((signal) => CODE_HEALTH_IDS.has(signal.id));
const MEASURES = new Set(CODE_HEALTH.map(baselineSectionOf));

export type RatchetPolicy = ReadonlyMap<string, number>;

export function ratchetSignals(policy: RatchetPolicy): readonly DoctorSignal[] {
  return CODE_HEALTH.map((signal) => {
    const threshold = policy.get(baselineSectionOf(signal));
    return threshold === undefined ? signal : { ...signal, thresholds: { standard: threshold, strict: threshold } };
  });
}

export function serializeRatchetPolicy(policy: RatchetPolicy): string {
  const thresholds = Object.fromEntries([...policy].sort(([a], [b]) => compareStrings(a, b)));
  return `${JSON.stringify({ schemaVersion: 1, thresholds }, null, 2)}\n`;
}

export function parseRatchetPolicy(text: string): RatchetPolicy {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed["schemaVersion"] !== 1 ||
    !isRecord(parsed["thresholds"]) ||
    Object.keys(parsed).some((key) => key !== "schemaVersion" && key !== "thresholds")
  ) {
    throw new Error(`${RATCHET_POLICY_PATH} must contain schemaVersion 1 and a thresholds object.`);
  }
  const thresholds = new Map<string, number>();
  for (const [name, value] of Object.entries(parsed["thresholds"])) {
    if (!MEASURES.has(name) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `${RATCHET_POLICY_PATH}: ${name} must name a code-health measure and set a non-negative integer.`,
      );
    }
    thresholds.set(name, value);
  }
  return thresholds;
}

export function readRatchetPolicy(root: string): RatchetPolicy | undefined {
  const path = join(root, RATCHET_POLICY_PATH);
  if (!existsSync(path)) return undefined;
  requireStandaloneRepository(root);
  return parseRatchetPolicy(readFileSync(path, "utf8"));
}

export function requireStandaloneRepository(root: string): void {
  if (existsSync(join(root, PROJECT_PATH))) {
    throw new Error("Standalone ratchet policy is for repositories without dads.project.json.");
  }
}
