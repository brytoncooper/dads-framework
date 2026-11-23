import { z } from "zod";

import type {
  ActorRef,
  AnyDslResource,
  DslActor,
  DslActorOptions,
  DslExpirableActorHolder,
  DslLazyResource,
  DslWildcardActorHolder,
} from "./dsl-types.js";
import { entityHandle, type EntityHandle } from "./entity-handle.js";
import type { WildcardHolder } from "./holders.js";

const defaultIdSchema: z.ZodType<string> = z.string().min(1);

export function parentRoleNameOf(wireName: string): string {
  const slashIndex = wireName.lastIndexOf("/");
  return slashIndex === -1 ? wireName : wireName.slice(slashIndex + 1);
}

export function isDslActor(value: unknown): value is DslActor {
  return typeof value === "function" && "kind" in value && value.kind === "dsl-actor";
}

export function isDslResource(value: unknown): value is AnyDslResource {
  return typeof value === "function" && "kind" in value && value.kind === "dsl-resource";
}

export function isDslLazyResource(value: unknown): value is DslLazyResource {
  return typeof value === "function" && !isDslActor(value) && !isDslResource(value);
}

type DslActorMetadata<WireName extends string> = {
  readonly kind: "dsl-actor";
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly handle: DslActor<WireName>["handle"];
  readonly entity: EntityHandle;
  readonly expiring: DslExpirableActorHolder<WireName>;
  readonly anyone: DslWildcardActorHolder<WireName>;
};

/**
 * Declare an authorization actor (e.g. `user`, `service_account`).
 * Call the returned handle as `user(id)` to construct a typed `ActorRef`.
 */
export function actor<const WireName extends string>(
  wireName: WireName,
  options?: DslActorOptions,
): DslActor<WireName> {
  const idSchema = options?.id ?? defaultIdSchema;
  const handle = entityHandle({ wireName, idSchema });

  const expiring: DslExpirableActorHolder<WireName> = {
    kind: "expirable",
    holder: handle,
    actorWireName: wireName,
  };
  const wildcardBase: WildcardHolder = {
    kind: "wildcard",
    entity: handle,
  };
  const anyone: DslWildcardActorHolder<WireName> = {
    kind: "wildcard",
    entity: handle,
    wireName,
    expiring: {
      kind: "expirable",
      holder: wildcardBase,
      wireName,
    },
  };

  function makeActorRef(id: string): ActorRef<WireName> {
    return {
      kind: "actor-ref",
      type: wireName,
      id,
    };
  }

  const metadata: DslActorMetadata<WireName> = {
    kind: "dsl-actor",
    wireName,
    idSchema,
    handle,
    entity: handle,
    expiring,
    anyone,
  };

  return Object.assign(makeActorRef, metadata);
}
