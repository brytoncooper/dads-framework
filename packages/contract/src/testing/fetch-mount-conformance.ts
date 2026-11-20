import { deepEqual, equal } from "node:assert/strict";
import type { FetchHandler } from "../lib/fetch-handler.js";

type OpenProtocolHost = (
  prefix: string,
  handler: FetchHandler,
) => Promise<{
  readonly exchange: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}>;

const prefix = "/protocol";
const bytes = [0, 0xff, 17, 128];
const firstCookie = "session=one; Path=/; HttpOnly";
const secondCookie = "state=two; Path=/; SameSite=Lax";
const fixture: FetchHandler = {
  async handler(request) {
    const url = new URL(request.url);
    if (url.pathname === prefix + "/echo") {
      const cloned = await request.clone().arrayBuffer();
      deepEqual([...new Uint8Array(cloned)], bytes);
      return new Response(await request.arrayBuffer(), {
        status: 201,
        headers: [
          ["content-type", "application/octet-stream"],
          ["set-cookie", firstCookie],
          ["set-cookie", secondCookie],
        ],
      });
    }
    if (request.headers.get("x-fixture-member") !== "yes") {
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    return Response.json({
      visibleIds: url.searchParams.get("color") === "blue" ? ["blue-item"] : [],
    });
  },
};

/** Prove portable transport of a mounted handler's answers without rebuilding its policy. */
export async function proveFetchMount(open: OpenProtocolHost): Promise<void> {
  const host = await open(prefix, fixture);
  try {
    await proveListAnswers(host.exchange);
    await proveBinaryAnswer(host.exchange);
  } finally {
    await host.close();
  }
}

async function proveListAnswers(
  exchange: (request: Request) => Promise<Response>,
): Promise<void> {
  const url = "http://test.local" + prefix + "/visible?color=blue";
  const denied = await exchange(new Request(url));
  equal(denied.status, 404);
  deepEqual(await denied.json(), { error: { code: "NOT_FOUND" } });

  const member = { headers: { "x-fixture-member": "yes" } };
  const visible = await exchange(new Request(url, member));
  equal(visible.status, 200);
  deepEqual(await visible.json(), { visibleIds: ["blue-item"] });

  const wrongMount = await exchange(
    new Request(url.replace(prefix, "/other"), member),
  );
  equal(wrongMount.status, 404);
}

async function proveBinaryAnswer(
  exchange: (request: Request) => Promise<Response>,
): Promise<void> {
  const echoed = await exchange(
    new Request("http://test.local" + prefix + "/echo", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Uint8Array.from(bytes),
    }),
  );
  equal(echoed.status, 201);
  equal(echoed.headers.get("content-type"), "application/octet-stream");
  deepEqual(echoed.headers.getSetCookie(), [firstCookie, secondCookie]);
  deepEqual([...new Uint8Array(await echoed.arrayBuffer())], bytes);
}
