import { useWorkbenchCopy } from "./copy/workbench-copy.js";
import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import { useState } from "react";
import { field, useAction } from "./actions.js";
import { signIn, signUp, type Account } from "./auth-client.js";

type AccountFormProps = {
  readonly onSignIn: (account: Account) => void;
  readonly hasInvitation: boolean;
};

export function AccountForm({ onSignIn, hasInvitation }: AccountFormProps) {
  const t = useWorkbenchCopy();
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const action = useAction();

  return (
    <Card className="access-card">
      <CardContent>
        <h2>
          {creating
            ? t("workbench.auth.createTitle")
            : t("workbench.auth.signIn")}
        </h2>
        {hasInvitation && <p>{t("workbench.auth.invitationEmail")}</p>}
        {verificationSent && (
          <p role="status" className="message">
            {t("workbench.auth.verify")}
          </p>
        )}
        <form
          key={String(creating)}
          className="fields"
          onSubmit={(event) => {
            action.submit(event, async (form) => {
              const credentials = {
                email: field(form, "email"),
                password: field(form, "password"),
              };
              if (creating) {
                await signUp({ ...credentials, name: field(form, "name") });
                setVerificationSent(true);
                setCreating(false);
              } else {
                onSignIn(await signIn(credentials));
              }
            });
          }}
        >
          {creating && (
            <div className="field">
              <Label htmlFor="name">{t("workbench.auth.name")}</Label>
              <Input id="name" name="name" autoComplete="name" required />
            </div>
          )}
          <div className="field">
            <Label htmlFor="email">{t("workbench.auth.email")}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
              }}
              required
            />
          </div>
          <div className="field">
            <Label htmlFor="password">{t("workbench.auth.password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={creating ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              required
            />
          </div>
          {action.error && (
            <p role="alert" className="error">
              {t(action.error)}
            </p>
          )}
          <Button disabled={action.pending}>
            {creating ? t("workbench.auth.create") : t("workbench.auth.signIn")}
          </Button>
        </form>
        <Button
          variant="outline"
          type="button"
          className="switch-account"
          disabled={action.pending}
          onClick={() => {
            setCreating(!creating);
          }}
        >
          {creating
            ? t("workbench.auth.existing")
            : t("workbench.auth.createTitle")}
        </Button>
      </CardContent>
    </Card>
  );
}
