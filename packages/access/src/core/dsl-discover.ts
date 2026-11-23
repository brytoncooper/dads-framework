import { isDslActor, isDslLazyResource, isDslResource } from "./dsl-actor.js";
import {
  getDslResourceRecord,
  getExpirableUsersetOwner,
  getRoleTokenOwner,
  type DslResourceRecord,
} from "./dsl-resource.js";
import type { DslNode } from "./dsl-resource-types.js";
import type { AnyDslResource, DslRoleHolder, DslSingleRoleHolder } from "./dsl-types.js";
import type { EntityHandle } from "./entity-handle.js";
import { isGrantableRole } from "./grantable.js";
import { isEntityHandleHolder, isExpirableHolder, isWildcardHolder } from "./holders.js";
import { isRoleToken } from "./refs.js";

export type DiscoveredDslGraph = {
  readonly actorHandles: ReadonlyMap<string, EntityHandle>;
  readonly resources: readonly DslResourceRecord[];
};

type DiscoveryState = {
  readonly visited: Set<object>;
  readonly actorHandles: Map<string, EntityHandle>;
  readonly resources: DslResourceRecord[];
  readonly resourceByWireName: Map<string, DslResourceRecord>;
};

function registerActorHandle(state: DiscoveryState, handle: EntityHandle): void {
  if (state.resourceByWireName.has(handle.wireName)) return;
  if (!state.actorHandles.has(handle.wireName)) {
    state.actorHandles.set(handle.wireName, handle);
  }
}

export function isDslHolderList(holder: DslRoleHolder): holder is readonly DslSingleRoleHolder[] {
  return Array.isArray(holder);
}

function discoverEntityHolder(state: DiscoveryState, entry: DslSingleRoleHolder): void {
  if (isExpirableHolder(entry)) {
    const owner = getExpirableUsersetOwner(entry);
    if (owner !== undefined) {
      discoverResource(state, owner);
      return;
    }
    discoverSingleHolder(state, entry.holder);
    return;
  }
  if (isGrantableRole(entry)) {
    registerActorHandle(state, entry.directSubject);
    return;
  }
  if (isWildcardHolder(entry)) {
    registerActorHandle(state, entry.entity);
    return;
  }
  if (isEntityHandleHolder(entry)) {
    registerActorHandle(state, entry);
  }
}

function discoverSingleHolder(state: DiscoveryState, entry: DslSingleRoleHolder): void {
  if (isDslLazyResource(entry)) {
    discoverResource(state, entry());
    return;
  }
  if (isDslResource(entry)) {
    discoverResource(state, entry);
    return;
  }
  if (isDslActor(entry)) {
    registerActorHandle(state, entry.handle);
    return;
  }
  if (isRoleToken(entry)) {
    const owner = getRoleTokenOwner(entry);
    if (owner !== undefined) discoverResource(state, owner);
    return;
  }
  discoverEntityHolder(state, entry);
}

function discoverHolder(state: DiscoveryState, holder: DslRoleHolder): void {
  if (isDslHolderList(holder)) {
    for (const item of holder) {
      discoverSingleHolder(state, item);
    }
    return;
  }
  discoverSingleHolder(state, holder);
}

function discoverResource(state: DiscoveryState, node: AnyDslResource): void {
  if (state.visited.has(node)) return;
  state.visited.add(node);

  const record = getDslResourceRecord(node);
  if (record === undefined) {
    throw new Error(`unregistered DSL resource ${node.wireName}`);
  }
  const existing = state.resourceByWireName.get(record.wireName);
  if (existing !== undefined && existing !== record) {
    throw new Error(`duplicate DSL resource wireName "${record.wireName}"`);
  }

  state.actorHandles.delete(record.wireName);
  state.resourceByWireName.set(record.wireName, record);
  state.resources.push(record);

  if (record.parentResource !== undefined) {
    discoverResource(state, record.parentResource);
  }
  for (const parent of record.parents) {
    discoverResource(state, parent);
  }
  for (const holder of Object.values(record.declaredRoles)) {
    discoverHolder(state, holder);
  }
  for (const child of record.childNodes) {
    discoverResource(state, child);
  }
}

export function discoverDslGraph(nodes: readonly DslNode[]): DiscoveredDslGraph {
  const state: DiscoveryState = {
    visited: new Set<object>(),
    actorHandles: new Map<string, EntityHandle>(),
    resources: [],
    resourceByWireName: new Map<string, DslResourceRecord>(),
  };

  for (const node of nodes) {
    if (isDslActor(node)) {
      registerActorHandle(state, node.handle);
    } else {
      discoverResource(state, node);
    }
  }
  return {
    actorHandles: state.actorHandles,
    resources: state.resources,
  };
}
