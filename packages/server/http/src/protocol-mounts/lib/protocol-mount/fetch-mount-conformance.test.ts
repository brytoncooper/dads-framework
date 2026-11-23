import Fastify from "fastify";
import { it } from "vitest";
import { proveFetchMount } from "@dads-framework/core/contract/testing";

import { mountFetchHandler } from "./mount-fetch-handler.js";

it("satisfies the Fetch mount contract over a Fastify socket", async () => {
  await proveFetchMount(async (prefix, handler) => {
    const app = Fastify({ logger: false });
    try {
      await app.register(mountFetchHandler(handler), { prefix });
      const origin = await app.listen({ port: 0, host: "127.0.0.1" });
      return {
        exchange: (request) => {
          const url = new URL(request.url);
          return fetch(
            new Request(origin + url.pathname + url.search, request),
          );
        },
        close: () => app.close(),
      };
    } catch (error) {
      await app.close();
      throw error;
    }
  });
});
