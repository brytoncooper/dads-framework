import { deadlineInterceptor, v1 } from "@authzed/authzed-node";

import { resolveSpiceDbSecurityMode, type SpiceDbSecurityMode } from "./logic/spice-db-security.js";

type SpiceDbConnection = ReturnType<typeof v1.NewClient>;

/**
 * Two channels to one SpiceDB: reads (checks, lookups, relationship reads,
 * schema) with the SDK's own defaults, and relationship writes with a gRPC
 * deadline on every call. A separate channel because the SDK takes per-call
 * deadlines only through interceptors on a whole client, and reads keep
 * their own posture.
 */
export function connectSpiceDb(
  options: {
    readonly endpoint: string;
    readonly presharedKey: string;
    readonly insecure: boolean;
  },
  relationshipWriteDeadlineMs: number,
): { readonly reads: SpiceDbConnection; readonly writes: SpiceDbConnection } {
  const security = toClientSecurity(resolveSpiceDbSecurityMode(options.endpoint, options.insecure));
  return {
    reads: v1.NewClient(options.presharedKey, options.endpoint, security),
    writes: v1.NewClient(options.presharedKey, options.endpoint, security, undefined, {
      interceptors: [deadlineInterceptor(relationshipWriteDeadlineMs)],
    }),
  };
}

function toClientSecurity(mode: SpiceDbSecurityMode): v1.ClientSecurity {
  if (mode === "secure") {
    return v1.ClientSecurity.SECURE;
  }
  return mode === "insecure-localhost"
    ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
    : v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS;
}
