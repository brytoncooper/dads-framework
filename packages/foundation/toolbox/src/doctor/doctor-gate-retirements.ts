import { posix } from "node:path";

import { isRecord, isString, isUnknownArray } from "../parse-guards.js";
import type { DoctorContext, DoctorPackage } from "./doctor-context.js";
import type { BaseComparisonInput } from "./doctor-gate-base.js";
import { hasReason, type BaselineSections } from "./doctor-gate-model.js";
import { countNegativeCases } from "./signals/commitment-issues/type-test-negative-cases.js";

const PROJECT_PATH = "dads.project.json";
const TRANSITIONS_PATH = ".agents/type-proof-transitions.json";
const INVARIANTS = "invariantsFiles";
const NEGATIVE_CASES = "typeTestNegativeCases";

type Owner = {
  readonly name: string;
  readonly root: string;
};

type Retirements = {
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly notes: readonly string[];
};

/** Only floors keyed by an actual removed package may leave the baseline. */
export function retiredOwnerFloors(
  input: BaseComparisonInput,
  base: BaselineSections,
): Retirements {
  const keys = new Map<string, ReadonlySet<string>>();
  const notes: string[] = [];
  const context = input.context;
  if (context === undefined || !context.exists(PROJECT_PATH))
    return { keys, notes };
  const former = baseOwners(input);
  if (former.length === 0) return { keys, notes };
  const current = context.packages();
  const actual = workspaceManifests(context);
  const proof = replacementProof(context, input.baseline.floors, current);
  for (const measure of [INVARIANTS, NEGATIVE_CASES]) {
    const removed = detectRemovedFloors(base, measure, {
      input,
      context,
      current,
      actual,
      former,
      proof,
    });
    keys.set(measure, new Set(removed.map(({ key }) => key)));
    notes.push(...removed.map(({ note }) => note));
  }
  return { keys, notes };
}

type Comparison = {
  readonly input: BaseComparisonInput;
  readonly context: DoctorContext;
  readonly current: readonly DoctorPackage[];
  readonly actual: readonly Owner[];
  readonly former: readonly Owner[];
  readonly proof: ProvesReplacement;
};

function detectRemovedFloors(
  base: BaselineSections,
  measure: string,
  comparison: Comparison,
) {
  const entries = base.get(measure);
  if (entries === undefined) return [];
  return [...entries].flatMap(([key, entry]) =>
    detectRemoval(measure, key, entry.value, comparison),
  );
}

function detectRemoval(
  measure: string,
  key: string,
  formerFloor: number,
  comparison: Comparison,
) {
  const { input, context, current, actual, former, proof } = comparison;
  if (input.baseline.floors.get(measure)?.has(key)) return [];
  const matches = former.filter(
    (entry) => key === (measure === INVARIANTS ? entry.name : entry.root),
  );
  const owner = matches.length === 1 ? matches[0] : undefined;
  if (owner === undefined || !rootWasRemoved(input, context, current, owner))
    return [];
  const successor = current.find((entry) => entry.name === owner.name);
  if (!consistentIdentity(actual, owner, successor)) return [];
  if (!removalHasProof(measure, owner, successor, formerFloor, proof))
    return [];
  const outcome =
    successor === undefined ? "retired" : `replaced by ${successor.root}`;
  return [
    {
      key,
      note: `${measure} ${key}: ${outcome} (former package ${owner.name} at ${owner.root})`,
    },
  ];
}

function consistentIdentity(
  actual: readonly Owner[],
  former: Owner,
  successor: Owner | undefined,
): boolean {
  const matches = actual.filter((entry) => entry.name === former.name);
  if (successor === undefined) return matches.length === 0;
  return matches.length === 1 && matches[0]?.root === successor.root;
}

function workspaceManifests(context: DoctorContext): readonly Owner[] {
  const suffix = "/package.json";
  return context.files().flatMap((path) => {
    if (!path.endsWith(suffix)) return [];
    const root = path.slice(0, -suffix.length);
    if (!safePackageRoot(root)) return [];
    const manifest: unknown = JSON.parse(context.read(path));
    if (!isRecord(manifest) || !isString(manifest["name"])) return [];
    return [{ root, name: manifest["name"] }];
  });
}

function baseOwners(input: BaseComparisonInput): readonly Owner[] {
  const shown = input.readAtRef(input.base, PROJECT_PATH);
  if (shown.status !== 0) return [];
  const parsed: unknown = JSON.parse(shown.stdout);
  if (!isRecord(parsed) || !isUnknownArray(parsed["packages"])) return [];
  return parsed["packages"].flatMap(readOwner);
}

function readOwner(value: unknown): readonly Owner[] {
  if (!isRecord(value)) return [];
  const { name, root } = value;
  if (!isString(name) || !isString(root) || !safePackageRoot(root)) return [];
  return [{ name, root }];
}

function safePackageRoot(root: string): boolean {
  return (
    root.startsWith("packages/") &&
    posix.normalize(root) === root &&
    !root.endsWith("/")
  );
}

function rootWasRemoved(
  input: BaseComparisonInput,
  context: DoctorContext,
  current: readonly DoctorPackage[],
  owner: Owner,
): boolean {
  if (
    context.exists(owner.root) ||
    current.some((entry) => entry.root === owner.root)
  )
    return false;
  if (
    context
      .files()
      .some((path) => path === owner.root || path.startsWith(`${owner.root}/`))
  )
    return false;
  const manifest = input.readAtRef(input.base, `${owner.root}/package.json`);
  if (manifest.status !== 0) return false;
  const former: unknown = JSON.parse(manifest.stdout);
  return isRecord(former) && former["name"] === owner.name;
}

type ProvesReplacement = (
  former: Owner,
  successor: DoctorPackage,
  formerFloor: number,
) => boolean;

function removalHasProof(
  measure: string,
  former: Owner,
  successor: DoctorPackage | undefined,
  formerFloor: number,
  proof: ProvesReplacement,
): boolean {
  if (successor === undefined) return true;
  return measure === NEGATIVE_CASES && proof(former, successor, formerFloor);
}

function replacementProof(
  context: DoctorContext,
  floors: BaselineSections,
  current: readonly DoctorPackage[],
): ProvesReplacement {
  if (!context.exists(TRANSITIONS_PATH)) return () => false;
  const transitions: unknown = JSON.parse(context.read(TRANSITIONS_PATH));
  if (!isRecord(transitions)) return () => false;
  const currentRoots = new Set(current.map((owner) => owner.root));
  const cases = countNegativeCases(context);
  return (former, successor, formerFloor) => {
    const receipt = transitions[former.root];
    if (
      !isRecord(receipt) ||
      receipt["package"] !== former.name ||
      receipt["formerFloor"] !== formerFloor
    )
      return false;
    const roots = receipt["replacementRoots"];
    const reason = receipt["reason"];
    if (!isUnknownArray(roots) || !roots.includes(successor.root)) return false;
    if (!isString(reason) || reason.trim() === "") return false;
    return roots.every((root) => {
      if (!isString(root) || !currentRoots.has(root)) return false;
      const entry = floors.get(NEGATIVE_CASES)?.get(root);
      return (
        entry !== undefined &&
        entry.value > 0 &&
        hasReason(entry) &&
        (cases.get(root)?.value ?? 0) >= entry.value
      );
    });
  };
}
