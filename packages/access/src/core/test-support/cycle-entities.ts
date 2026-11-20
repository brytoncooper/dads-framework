import { z } from "zod";
import { entityHandle } from "../entity-handle.js";

export const Alpha = entityHandle({
  wireName: "test/alpha",
  idSchema: z.string(),
});

export const Beta = entityHandle({
  wireName: "test/beta",
  idSchema: z.string(),
});
