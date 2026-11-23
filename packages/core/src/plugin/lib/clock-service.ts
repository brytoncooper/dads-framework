import type { Clock } from "../../runtime/clock/index.js";

import type { Plugin } from "./define-plugin.js";
import { defineService } from "./define-service.js";
import { providePlugin } from "./provide-plugin.js";

/** Narrow capability token for reading the current time. */
export const clockService = defineService("clock").ofType<Clock>();

/** Provide a `Clock` implementation to a plugin composition. */
export function provideClock<Provided extends Clock>(
  clock: Provided,
): Plugin<"clock", never, Provided, never, never, never, "clock", never>;
export function provideClock<const Name extends string, Provided extends Clock>(
  clock: Provided,
  pluginName: Name,
): Plugin<Name, never, Provided, never, never, never, "clock", never>;
export function provideClock<Provided extends Clock>(
  clock: Provided,
  pluginName = "clock",
): Plugin<string, never, Provided, never, never, never, "clock", never> {
  return providePlugin(pluginName, clockService, () => clock);
}
