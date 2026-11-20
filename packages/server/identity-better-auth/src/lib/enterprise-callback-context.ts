import { AsyncLocalStorage } from "node:async_hooks";
import type { EnterpriseSsoProvider } from "./enterprise-options.js";

type EnterpriseCallback = {
  readonly provider: EnterpriseSsoProvider;
  profileApproved?: boolean;
};

const callbacks = new AsyncLocalStorage<EnterpriseCallback>();

export function enterpriseCallback(): EnterpriseCallback | undefined {
  return callbacks.getStore();
}

export function withEnterpriseCallback(
  provider: EnterpriseSsoProvider,
  callback: () => Promise<Response>,
): Promise<Response> {
  return callbacks.run({ provider }, callback);
}
