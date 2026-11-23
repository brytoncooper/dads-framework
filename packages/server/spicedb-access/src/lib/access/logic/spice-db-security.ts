export type SpiceDbSecurityMode = "secure" | "insecure-localhost" | "insecure-plaintext";

/** Chooses the Authzed transport mode without dropping request credentials. */
export function resolveSpiceDbSecurityMode(endpoint: string, insecure: boolean): SpiceDbSecurityMode {
  if (!insecure) {
    return "secure";
  }
  return endpoint.startsWith("localhost:") ? "insecure-localhost" : "insecure-plaintext";
}
