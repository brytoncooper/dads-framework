import type { IdentityEmail } from "@dads-framework/identity";
import type { BetterAuthIdentityOptions } from "./identity-options.js";

export function identityEmailSender(options: BetterAuthIdentityOptions) {
  return (message: IdentityEmail): void => {
    void Promise.resolve()
      .then(() => options.enqueueEmail(message))
      .catch(() => {
        try {
          options.onEmailError?.();
        } catch {
          // A receipt or link is never written to the authentication response.
        }
      });
  };
}
