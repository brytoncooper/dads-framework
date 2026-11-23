import type { FetchHandler } from "../lib/fetch-handler.js";

/** Reference host for GET and POST below a protocol prefix. Uses Fetch directly. */
export function inMemoryFetchMount(prefix: string, handler: FetchHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const mounted = path.startsWith(prefix + "/");
    const supported = request.method === "GET" || request.method === "POST";
    return mounted && supported ? handler.handler(request) : new Response(null, { status: 404 });
  };
}
