/**
 * Named trigger that removes a grantable role. Sweepers consume these later;
 * this kit only records the declaration.
 */
export type LifecycleTrigger = {
  readonly kind: "lifecycle";
  readonly name: string;
};

export function lifecycleTrigger(name: string): LifecycleTrigger {
  return { kind: "lifecycle", name };
}
