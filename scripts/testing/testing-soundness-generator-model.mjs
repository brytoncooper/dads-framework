export const PROJECT_IDS = ["p0", "p1", "p2"];
export const TASK_KINDS = ["lint", "typecheck", "test"];

export function assertSeed(seed) {
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("--seed must be an unsigned 32-bit decimal integer.");
  return seed;
}

export function assertDecimalSeed(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("--seed must be an unsigned 32-bit decimal integer.");
  const seed = Number(value);
  return assertSeed(seed);
}

export function topologyForSeed(seed) {
  return seed % 2 === 0 ? "fanout" : "chain";
}

export function dependenciesForProject(seed, project) {
  if (project === "p0") return [];
  if (project === "p1") return ["p0"];
  return [seed % 2 === 0 ? "p0" : "p1"];
}

export function createPrng(seed) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x21f0aaad) >>> 0;
    state = Math.imul(state ^ (state >>> 15), 0x735a2d97) >>> 0;
    return (state ^ (state >>> 15)) >>> 0;
  };
}

export function makeModel(seed) {
  assertSeed(seed);
  const next = createPrng(seed);
  const unusedValues = new Map(PROJECT_IDS.map((project) => [project, 100 + (next() % 900)]));
  const ownIncrements = new Map(PROJECT_IDS.map((project) => [project, 1 + (next() % 90)]));
  const values = new Map();
  for (const project of PROJECT_IDS) {
    const upstream = dependenciesForProject(seed, project)[0];
    values.set(project, (upstream === undefined ? 0 : values.get(upstream)) + ownIncrements.get(project));
  }
  return {
    seed,
    topology: topologyForSeed(seed),
    projects: PROJECT_IDS.map((id) => ({
      id,
      root: `packages/${id}`,
      dependsOn: dependenciesForProject(seed, id),
      value: values.get(id),
      unusedValue: unusedValues.get(id),
      ownIncrement: ownIncrements.get(id),
    })),
  };
}

export function taskIds(projects, kinds = TASK_KINDS) {
  return projects.flatMap((project) => kinds.map((kind) => `${project}:${kind}`)).sort();
}

export function downstreamProjects(model, owner) {
  const result = [];
  const pending = [owner];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const project of model.projects) {
      if (project.dependsOn.includes(current) && !result.includes(project.id)) {
        result.push(project.id);
        pending.push(project.id);
      }
    }
  }
  return result.sort();
}

export function projectClosure(model, owner) {
  return [owner, ...downstreamProjects(model, owner)].sort();
}
