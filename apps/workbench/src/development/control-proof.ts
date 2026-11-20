import { createHmac, timingSafeEqual } from "node:crypto";

export const controlProtocol = "dads-workbench-control-v1";

/** The server's identity proof cannot be reflected back as a shutdown instruction. */
export function serverProof(key: string, nonce: string): string {
  return createHmac("sha256", key)
    .update(`dads-control-server-v1\0${nonce}`)
    .digest("hex");
}

export function stopProof(key: string, nonce: string): string {
  return createHmac("sha256", key)
    .update(`dads-control-stop-v1\0${nonce}`)
    .digest("hex");
}

export function matchesProof(received: unknown, expected: string): boolean {
  return (
    typeof received === "string" &&
    /^[a-f0-9]{64}$/.test(received) &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  );
}
