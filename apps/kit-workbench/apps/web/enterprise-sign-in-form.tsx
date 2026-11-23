import { Button } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import { useEffect, useState } from "react";
import { field, useAction } from "./actions.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";
import { beginEnterpriseSignIn, readSignInOptions, returnedWithEnterpriseError } from "./enterprise-sign-in-client.js";

export function EnterpriseSignInForm() {
  const t = useWorkbenchCopy();
  const [available, setAvailable] = useState(false);
  const [returnedError, setReturnedError] = useState(() => returnedWithEnterpriseError(new URL(window.location.href)));
  const [open, setOpen] = useState(returnedError);
  const action = useAction();

  useEffect(() => {
    const controller = new AbortController();
    void readSignInOptions(controller.signal).then(
      ({ enterpriseSso }) => {
        if (!controller.signal.aborted) setAvailable(enterpriseSso);
      },
      () => {
        if (!controller.signal.aborted) setAvailable(false);
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  if (!available) return null;

  return (
    <details
      className="enterprise-sign-in"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>{t("workbench.auth.enterprise.title")}</summary>
      <form
        className="fields"
        onSubmit={(event) => {
          action.submit(event, async (form) => {
            setReturnedError(false);
            const provider = field(form, "provider").trim();
            const destination = await beginEnterpriseSignIn(provider, new URL(window.location.href));
            window.location.assign(destination);
          });
        }}
      >
        <div className="field">
          <Label htmlFor="enterprise-provider">{t("workbench.auth.enterprise.provider")}</Label>
          <Input
            id="enterprise-provider"
            name="provider"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={80}
            required
            aria-describedby="enterprise-provider-help"
          />
          <p id="enterprise-provider-help" className="field-hint">
            {t("workbench.auth.enterprise.help")}
          </p>
        </div>
        {(action.error || returnedError) && (
          <p className="error" role="alert">
            {t("workbench.auth.enterprise.error")}
          </p>
        )}
        <Button variant="outline" disabled={action.pending}>
          {t(action.pending ? "workbench.auth.enterprise.redirecting" : "workbench.auth.enterprise.continue")}
        </Button>
      </form>
    </details>
  );
}
