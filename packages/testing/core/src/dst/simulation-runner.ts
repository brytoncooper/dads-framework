import { parseSeed, resolveDstSeed, type DstSeedInput } from "./prng.js";
import type { SimClockInput } from "./sim-clock.js";
import { createSimWorld, type SimWorld } from "./sim-world.js";

/**
 * Property-based stateful simulation runner with invariant checking, automatic
 * delta-debugging shrinking, and one-env-var `DADS_DST_SEED` failure replay.
 */

export type SimAction<State, Input> = {
  readonly name: string;
  readonly weight?: number;
  readonly enabled?: (state: State, world: SimWorld) => boolean;
  readonly generate: (state: State, world: SimWorld) => Input;
  readonly execute: (state: State, input: Input, world: SimWorld) => void | Promise<void>;
};

export type PreparedSimStep<State> = {
  readonly action: string;
  readonly input: unknown;
  readonly run: (state: State, world: SimWorld) => void | Promise<void>;
};

export type AnySimAction<State> = {
  readonly name: string;
  readonly weight: number;
  readonly enabled: (state: State, world: SimWorld) => boolean;
  readonly prepare: (state: State, world: SimWorld) => PreparedSimStep<State>;
};

export type SimInvariant<State> = {
  readonly name: string;
  readonly check: (state: State, world: SimWorld) => void | Promise<void>;
};

export type SimulationSpec<State> = {
  readonly name: string;
  readonly createState: (world: SimWorld) => State | Promise<State>;
  readonly actions: readonly AnySimAction<State>[];
  readonly invariants: readonly SimInvariant<State>[];
};

export type RecordedSimStep = {
  readonly action: string;
  readonly input: unknown;
};

export type RunSimulationOptions = {
  /** Number of distinct seeds to explore when `DADS_DST_SEED` is not pinned. Defaults to `25`. */
  readonly seeds?: number;
  /** First seed to run; subsequent seeds derive deterministically from `baseSeed + i`. */
  readonly baseSeed?: DstSeedInput;
  /** Maximum actions executed per seed. Defaults to `40`. */
  readonly steps?: number;
  /** Starting timestamp for each seed's `SimClock`. */
  readonly startTime?: SimClockInput;
  /** When true (default), shrinks a failing action sequence to a minimal repro. */
  readonly shrink?: boolean;
  /** Environment object checked for `DADS_DST_SEED`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
};

export type SimulationReport = {
  readonly ok: true;
  readonly simulation: string;
  readonly seedsRun: number;
  readonly totalSteps: number;
  readonly actionCounts: Readonly<Record<string, number>>;
};

export type SimulationFailureDetail = {
  readonly simulation: string;
  readonly seed: number;
  readonly failedAt: string;
  readonly originalStepCount: number;
  readonly minimizedSteps: readonly RecordedSimStep[];
  readonly replayEnv: string;
  readonly causeMessage: string;
};

export class SimulationFailureError extends Error {
  readonly detail: SimulationFailureDetail;

  constructor(detail: SimulationFailureDetail, cause: unknown) {
    const stepsText = detail.minimizedSteps
      .map((step, idx) => `  ${String(idx + 1)}. ${step.action}(${safeJson(step.input)})`)
      .join("\n");
    super(
      [
        `Simulation "${detail.simulation}" failed at ${detail.failedAt} (seed=${String(detail.seed)}, ${String(detail.minimizedSteps.length)}/${String(detail.originalStepCount)} steps after shrinking):`,
        `  ${detail.causeMessage}`,
        `Replay with: ${detail.replayEnv}`,
        "Minimal failing sequence:",
        stepsText,
      ].join("\n"),
      { cause },
    );
    this.name = "SimulationFailureError";
    this.detail = detail;
  }
}

/** Type-safe action constructor capturing `Input` in a closure with zero type assertions. */
export function defineSimAction<State, Input>(action: SimAction<State, Input>): AnySimAction<State> {
  const weight = action.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Action "${action.name}" weight must be a positive finite number.`);
  }
  return {
    name: action.name,
    weight,
    enabled: action.enabled ?? (() => true),
    prepare: (state, world) => {
      const typedInput: Input = action.generate(state, world);
      return {
        action: action.name,
        input: typedInput,
        run: (nextState, nextWorld) => action.execute(nextState, typedInput, nextWorld),
      };
    },
  };
}

export function defineSimulation<State>(spec: SimulationSpec<State>): SimulationSpec<State> {
  if (spec.actions.length === 0) {
    throw new Error(`Simulation "${spec.name}" must declare at least one action.`);
  }
  return spec;
}

export async function runSimulation<State>(
  spec: SimulationSpec<State>,
  options: RunSimulationOptions = {},
): Promise<SimulationReport> {
  const seedsToRun = resolveSeedList(options);
  const maxSteps = options.steps ?? 40;
  const shouldShrink = options.shrink ?? true;
  const actionCounts: Record<string, number> = {};
  let totalSteps = 0;

  for (const seed of seedsToRun) {
    const outcome = await runOneSeed(spec, seed, maxSteps, options.startTime, actionCounts);
    totalSteps += outcome.stepsExecuted;
    if (outcome.failure !== undefined) {
      const minimized = shouldShrink
        ? await shrinkSequence(spec, seed, options.startTime, outcome.steps, outcome.failure.failedAt)
        : outcome.steps;
      throw new SimulationFailureError(
        {
          simulation: spec.name,
          seed,
          failedAt: outcome.failure.failedAt,
          originalStepCount: outcome.steps.length,
          minimizedSteps: minimized.map((step) => ({ action: step.action, input: step.input })),
          replayEnv: `DADS_DST_SEED=${String(seed)}`,
          causeMessage: errorMessage(outcome.failure.error),
        },
        outcome.failure.error,
      );
    }
  }

  return {
    ok: true,
    simulation: spec.name,
    seedsRun: seedsToRun.length,
    totalSteps,
    actionCounts,
  };
}

function resolveSeedList(options: RunSimulationOptions): readonly number[] {
  const resolved = resolveDstSeed(options.baseSeed ?? 1, options.env);
  if (resolved.fromEnv) return [resolved.seed];
  const count = options.seeds ?? 25;
  const base = options.baseSeed === undefined ? 1 : parseSeed(options.baseSeed);
  const list: number[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push((base + i) >>> 0);
  }
  return list;
}

type SeedFailure = {
  readonly failedAt: string;
  readonly error: unknown;
};

type SeedOutcome<State> = {
  readonly stepsExecuted: number;
  readonly steps: readonly PreparedSimStep<State>[];
  readonly failure?: SeedFailure;
};

async function runOneSeed<State>(
  spec: SimulationSpec<State>,
  seed: number,
  maxSteps: number,
  startTime: SimClockInput | undefined,
  actionCounts: Record<string, number>,
): Promise<SeedOutcome<State>> {
  const world = createSimWorld({ seed, ...(startTime === undefined ? {} : { startTime }) });
  return resolveState(spec.createState(world)).then(async (state) => {
    const steps: PreparedSimStep<State>[] = [];
    const initialFailure = await checkInvariants(spec.invariants, state, world);
    if (initialFailure !== undefined) return { stepsExecuted: 0, steps, failure: initialFailure };

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const action = pickWeightedAction(spec.actions, state, world);
      if (action === undefined) break;
      const prepared = action.prepare(state, world);
      steps.push(prepared);
      actionCounts[action.name] = (actionCounts[action.name] ?? 0) + 1;
      world.record(`action:${action.name}`);

      const failure = await runStepAndInvariants(prepared, spec.invariants, state, world);
      if (failure !== undefined) return { stepsExecuted: steps.length, steps, failure };
    }
    return { stepsExecuted: steps.length, steps };
  });
}

async function runStepAndInvariants<State>(
  step: PreparedSimStep<State>,
  invariants: readonly SimInvariant<State>[],
  state: State,
  world: SimWorld,
): Promise<SeedFailure | undefined> {
  try {
    await step.run(state, world);
  } catch (error: unknown) {
    return { failedAt: `action:${step.action}`, error };
  }
  return checkInvariants(invariants, state, world);
}

async function checkInvariants<State>(
  invariants: readonly SimInvariant<State>[],
  state: State,
  world: SimWorld,
): Promise<SeedFailure | undefined> {
  for (const invariant of invariants) {
    try {
      await invariant.check(state, world);
    } catch (error: unknown) {
      return { failedAt: `invariant:${invariant.name}`, error };
    }
  }
  return undefined;
}

function pickWeightedAction<State>(
  actions: readonly AnySimAction<State>[],
  state: State,
  world: SimWorld,
): AnySimAction<State> | undefined {
  const eligible = actions.filter((action) => action.enabled(state, world));
  if (eligible.length === 0) return undefined;
  let totalWeight = 0;
  for (const action of eligible) totalWeight += action.weight;
  let cursor = world.rng.nextFloat() * totalWeight;
  for (const action of eligible) {
    cursor -= action.weight;
    if (cursor < 0) return action;
  }
  return eligible[eligible.length - 1];
}

/**
 * Delta-debugging shrinker: repeatedly removes chunks, then individual steps,
 * keeping the shortest subsequence that still reproduces `targetFailure`.
 */
async function shrinkSequence<State>(
  spec: SimulationSpec<State>,
  seed: number,
  startTime: SimClockInput | undefined,
  initial: readonly PreparedSimStep<State>[],
  targetFailure: string,
): Promise<readonly PreparedSimStep<State>[]> {
  let current = [...initial];
  let chunkSize = Math.floor(current.length / 2);

  while (chunkSize >= 1) {
    const shrunk = await tryRemoveChunks(spec, seed, startTime, current, chunkSize, targetFailure);
    if (shrunk.length < current.length) {
      current = shrunk;
      chunkSize = Math.min(chunkSize, Math.floor(current.length / 2));
    } else {
      chunkSize = Math.floor(chunkSize / 2);
    }
  }
  return current;
}

async function tryRemoveChunks<State>(
  spec: SimulationSpec<State>,
  seed: number,
  startTime: SimClockInput | undefined,
  steps: readonly PreparedSimStep<State>[],
  chunkSize: number,
  targetFailure: string,
): Promise<PreparedSimStep<State>[]> {
  let candidate = [...steps];
  let index = 0;
  while (index < candidate.length && candidate.length > 1) {
    const next = [...candidate.slice(0, index), ...candidate.slice(index + chunkSize)];
    if (next.length > 0 && (await reproducesFailure(spec, seed, startTime, next, targetFailure))) {
      candidate = next;
    } else {
      index += chunkSize;
    }
  }
  return candidate;
}

async function reproducesFailure<State>(
  spec: SimulationSpec<State>,
  seed: number,
  startTime: SimClockInput | undefined,
  steps: readonly PreparedSimStep<State>[],
  targetFailure: string,
): Promise<boolean> {
  const world = createSimWorld({ seed, ...(startTime === undefined ? {} : { startTime }) });
  return resolveState(spec.createState(world)).then(async (state) => {
    const actionsByName = new Map(spec.actions.map((action) => [action.name, action]));

    for (const step of steps) {
      const action = actionsByName.get(step.action);
      if (action === undefined || !action.enabled(state, world)) return false;
      const failure = await runStepAndInvariants(step, spec.invariants, state, world);
      if (failure !== undefined) return failure.failedAt === targetFailure;
    }
    return false;
  });
}

function resolveState<State>(value: State | Promise<State>): Promise<State> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
