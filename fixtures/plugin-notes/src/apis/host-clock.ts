import { providePlugin } from "@dads-framework/plugin";

import { clockService } from "../clock-service.js";

export const apiClock = providePlugin("api-clock", clockService, () => ({
  now: () => new Date(),
}));
