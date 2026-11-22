type TarjanState = {
  index: number;
  readonly indices: Map<string, number>;
  readonly lowlink: Map<string, number>;
  readonly stack: string[];
  readonly onStack: Set<string>;
  readonly sccs: string[][];
};

/** Computes strongly connected components of a directed string-keyed graph. */
export function findStronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const state: TarjanState = {
    index: 0,
    indices: new Map(),
    lowlink: new Map(),
    stack: [],
    onStack: new Set(),
    sccs: [],
  };
  for (const node of adjacency.keys()) {
    if (!state.indices.has(node)) {
      strongConnect(node, adjacency, state);
    }
  }
  return state.sccs;
}

function strongConnect(
  node: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  state: TarjanState,
): void {
  const currentIndex = state.index;
  state.indices.set(node, currentIndex);
  state.lowlink.set(node, currentIndex);
  state.index += 1;
  state.stack.push(node);
  state.onStack.add(node);

  for (const neighbor of adjacency.get(node) ?? []) {
    visitNeighbor(node, neighbor, adjacency, state);
  }
  if (state.lowlink.get(node) === currentIndex) {
    state.sccs.push(popComponent(node, state));
  }
}

function visitNeighbor(
  node: string,
  neighbor: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  state: TarjanState,
): void {
  const currentLow = state.lowlink.get(node) ?? 0;
  if (!state.indices.has(neighbor)) {
    strongConnect(neighbor, adjacency, state);
    const neighborLow = state.lowlink.get(neighbor) ?? currentLow;
    state.lowlink.set(node, Math.min(currentLow, neighborLow));
    return;
  }
  if (state.onStack.has(neighbor)) {
    const neighborIndex = state.indices.get(neighbor) ?? currentLow;
    state.lowlink.set(node, Math.min(currentLow, neighborIndex));
  }
}

function popComponent(root: string, state: TarjanState): string[] {
  const component: string[] = [];
  while (state.stack.length > 0) {
    const popped = state.stack.pop();
    if (popped === undefined) break;
    state.onStack.delete(popped);
    component.push(popped);
    if (popped === root) break;
  }
  return component;
}
