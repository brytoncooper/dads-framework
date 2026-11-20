import { AsyncLocalStorage } from "node:async_hooks";
import type { SpiceDbConsistencyToken } from "./authorization.js";
import { presentToken } from "./present-token.js";

type AuthorizationConsistencyOnThisRequest = {
  inbound: SpiceDbConsistencyToken | undefined;
  written: SpiceDbConsistencyToken | undefined;
};

const authorizationConsistencyOnThisRequest =
  new AsyncLocalStorage<AuthorizationConsistencyOnThisRequest>();

export function runWithAuthorizationConsistency<T>(
  inboundToken: SpiceDbConsistencyToken | undefined,
  work: () => T,
): T {
  return authorizationConsistencyOnThisRequest.run(
    { inbound: presentToken(inboundToken), written: undefined },
    work,
  );
}

export function authorizationConsistencyTokenOnThisRequest():
  SpiceDbConsistencyToken | undefined {
  const store = authorizationConsistencyOnThisRequest.getStore();
  if (store === undefined) return undefined;
  return presentToken(store.written) ?? presentToken(store.inbound);
}

export function recordWrittenAuthorizationConsistency(
  token: SpiceDbConsistencyToken,
): void {
  const store = authorizationConsistencyOnThisRequest.getStore();
  const written = presentToken(token);
  if (store === undefined || written === undefined) return;
  store.written = written;
}

export function writtenAuthorizationConsistencyOnThisRequest():
  SpiceDbConsistencyToken | undefined {
  return presentToken(
    authorizationConsistencyOnThisRequest.getStore()?.written,
  );
}
