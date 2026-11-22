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
import { entityHandle } from "./entity-handle.js";

const defaultIdSchema: z.ZodType<string> = z.string().min(1);

export function parentRoleNameOf(wireName: string): string {
  const slashIndex = wireName.lastIndexOf("/");
  return slashIndex === -1 ? wireName : wireName.slice(slashIndex + 1);
}

export function isDslActor(value: unknown): value is DslActor {
  return (
    typeof value === "function" && "kind" in value && value.kind === "dsl-actor"
  );
}

export function isDslResource(value: unknown): value is AnyDslResource {
  return (
    typeof value === "function" &&
    "kind" in value &&
    value.kind === "dsl-resource"
  );
}

export function isDslLazyResource(value: unknown): value is DslLazyResource {
  return (
    typeof value === "function" && !isDslActor(value) && !isDslResource(value)
  );
}

type DslActorMetadata<WireName extends string> = {
  readonly kind: "dsl-actor";
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly handle: DslActor<WireName>["handle"];
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
  const handle =
    options?.kind === undefined
      ? entityHandle({ wireName, idSchema })
      : entityHandle({ wireName, idSchema, kind: options.kind });

  const expiring: DslExpirableActorHolder<WireName> = {
    kind: "expirable",
    holder: handle,
    actorWireName: wireName,
  };
  const anyone: DslWildcardActorHolder<WireName> = {
    kind: "wildcard",
    entity: handle,
    wireName,
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
    expiring,
    anyone,
  };

  return Object.assign(makeActorRef, metadata);
}
