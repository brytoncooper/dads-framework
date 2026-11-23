import { assertValidLiveActionMetadata, type LiveActionDefinition } from "./live-action.js";

/**
 * In-memory registry of live operational actions.
 *
 * Rejects duplicate names and invalid metadata at registration time so action
 * wiring errors fail immediately during startup.
 */
export class LiveActionRegistry {
  private readonly actions = new Map<string, LiveActionDefinition>();

  register<TInput>(action: LiveActionDefinition<TInput>): this {
    assertValidLiveActionMetadata(action);
    if (this.actions.has(action.name)) {
      throw new Error(`Live action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
    return this;
  }

  get(name: string): LiveActionDefinition | undefined {
    return this.actions.get(name);
  }

  list(): readonly LiveActionDefinition[] {
    return [...this.actions.values()];
  }
}

/** Create a registry optionally seeded with initial live action definitions. */
export function createLiveActionRegistry(actions: readonly LiveActionDefinition[] = []): LiveActionRegistry {
  const registry = new LiveActionRegistry();
  for (const action of actions) {
    registry.register(action);
  }
  return registry;
}
