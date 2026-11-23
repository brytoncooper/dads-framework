import { it } from "vitest";
import { proveFetchMount } from "./fetch-mount-conformance.js";
import { inMemoryFetchMount } from "./in-memory-fetch-mount.js";

it("satisfies the Fetch mount contract through the in-memory host", async () => {
  await proveFetchMount((prefix, handler) =>
    Promise.resolve({
      exchange: inMemoryFetchMount(prefix, handler),
      close: () => Promise.resolve(),
    }),
  );
});
