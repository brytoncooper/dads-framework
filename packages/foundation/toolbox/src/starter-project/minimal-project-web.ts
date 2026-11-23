import type { StarterProjectFile } from "./render-starter-project.js";

/** Minimal React web shell: sign-in form, copy table, and browser entrypoint. */
export function renderMinimalWebFiles(): readonly StarterProjectFile[] {
  return [accountFormFile(), workbenchCopyFile(), webMainFile()];
}

function accountFormFile(): StarterProjectFile {
  return {
    path: "apps/web/account-form.tsx",
    content: `import { useWorkbenchCopy } from "./copy/workbench-copy.js";
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
`,
  };
}

function workbenchCopyFile(): StarterProjectFile {
  return {
    path: "apps/web/copy/workbench-copy.ts",
    content: `import { createCopyHook, defineCopy, type CopyKey } from "@dads-framework/ui/copy";

export const workbenchCopy = defineCopy({
  "workbench.brand": { en: "Dads App" },
  "workbench.title.signedOut": { en: "Sign in to your workspace." },
  "workbench.title.signedIn": { en: "Your workspaces" },
  "workbench.starter": { en: "Dads minimal app" },
  "workbench.summary": {
    en: "Create a workspace, invite collaborators, and add your own domains.",
  },
  "workbench.links": { en: "Application links" },
  "workbench.apiHealth": { en: "API health" },
  "workbench.session.loading": { en: "Checking session…" },
  "workbench.auth.signOut": { en: "Sign out" },
  "workbench.auth.signIn": { en: "Sign in" },
  "workbench.auth.createTitle": { en: "Create an account" },
  "workbench.auth.create": { en: "Create account" },
  "workbench.auth.existing": { en: "Use an existing account" },
  "workbench.auth.invitationEmail": {
    en: "Use the email address on your invitation.",
  },
  "workbench.auth.verify": {
    en: "Check your email for the verification link. In local development, run npm run dev:mail to read the message.",
  },
  "workbench.auth.name": { en: "Name" },
  "workbench.auth.email": { en: "Email" },
  "workbench.auth.password": { en: "Password" },
  "workbench.tenant.controls": { en: "Workspace controls" },
  "workbench.tenant.title": { en: "Workspaces" },
  "workbench.tenant.loading": { en: "Loading workspaces…" },
  "workbench.tenant.active": { en: "Active workspace" },
  "workbench.tenant.name": { en: "New workspace name" },
  "workbench.tenant.create": { en: "Create workspace" },
  "workbench.tenant.readyBody": {
    en: "Run npx dad add resource <name> --api customer to add your first domain.",
  },
  "workbench.tenant.emptyTitle": { en: "Start a workspace" },
  "workbench.tenant.emptyBody": {
    en: "Create a workspace or accept an invitation to begin.",
  },
  "workbench.invite.title": { en: "Workspace invitation" },
  "workbench.invite.accept": { en: "Accept invitation" },
  "workbench.invite.open": { en: "Invite a collaborator" },
  "workbench.invite.email": { en: "Collaborator email" },
  "workbench.invite.sent": { en: "Invitation sent." },
  "workbench.invite.send": { en: "Send invitation" },
  "workbench.retry": { en: "Retry" },
  "workbench.error.network": { en: "Could not reach the server. Try again." },
  "workbench.error.session": { en: "Sign in to continue." },
  "workbench.error.signIn": {
    en: "Check your email and password. Open the verification email if you have not verified the account.",
  },
  "workbench.error.forbidden": {
    en: "Your account does not have access to this action.",
  },
  "workbench.error.missing": { en: "This item is unavailable." },
  "workbench.error.conflict": {
    en: "The workspace changed. Check the latest state and try again.",
  },
  "workbench.error.input": {
    en: "Check the information you entered and try again.",
  },
  "workbench.error.rate": {
    en: "Too many requests. Wait a moment and try again.",
  },
  "workbench.error.generic": { en: "The request failed. Try again." },
});

export type WorkbenchCopyKey = CopyKey<typeof workbenchCopy>;
export const useWorkbenchCopy = createCopyHook(workbenchCopy);
`,
  };
}

function webMainFile(): StarterProjectFile {
  return {
    path: "apps/web/main.tsx",
    content: `import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";
import { onUnauthorizedResponse } from "@dads-framework/client";
import { Button } from "@dads-framework/ui/elements";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountForm } from "./account-form.js";
import { describeFailure, useAction } from "./actions.js";
import { readAccount, signOut, type Account } from "./auth-client.js";
import { Workbench } from "./workbench.js";
import "./styles.css";

function invitationToken() {
  if (window.location.pathname !== "/accept-tenant-invitation") return null;
  return new URLSearchParams(window.location.hash.slice(1)).get("token");
}

function App() {
  const t = useWorkbenchCopy();
  const [account, setAccount] = useState<Account | null>();
  const [invitation, setInvitation] = useState(invitationToken);
  const [failure, setFailure] = useState<WorkbenchCopyKey>();
  const [attempt, setAttempt] = useState(0);
  const signOutAction = useAction();

  useEffect(() => {
    const controller = new AbortController();
    void readAccount(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setAccount(value);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setFailure(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [attempt]);

  useEffect(
    () =>
      onUnauthorizedResponse(() => {
        setAccount(null);
      }),
    [],
  );

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <a href="/" className="brand">
            {t("workbench.brand")}
          </a>
          <nav className="masthead-links" aria-label={t("workbench.links")}>
            <a href="/api/health">{t("workbench.apiHealth")}</a>
            {account && (
              <Button
                variant="outline"
                size="sm"
                disabled={signOutAction.pending}
                onClick={() =>
                  void signOutAction.run(async () => {
                    await signOut();
                    setAccount(null);
                  })
                }
              >
                {t("workbench.auth.signOut")}
              </Button>
            )}
          </nav>
        </div>
      </header>
      <main className="shell">
        <div className="hero">
          <p className="eyebrow">
            {account ? account.email : t("workbench.starter")}
          </p>
          <h1>
            {account
              ? t("workbench.title.signedIn")
              : t("workbench.title.signedOut")}
          </h1>
          <p>{t("workbench.summary")}</p>
        </div>
        {signOutAction.error && (
          <p className="error" role="alert">
            {t(signOutAction.error)}
          </p>
        )}
        {failure && (
          <p className="error" role="alert">
            {t(failure)}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFailure(undefined);
                setAttempt(attempt + 1);
              }}
            >
              {t("workbench.retry")}
            </Button>
          </p>
        )}
        {account === undefined && failure === undefined && (
          <p role="status">{t("workbench.session.loading")}</p>
        )}
        {account === null && (
          <AccountForm
            onSignIn={setAccount}
            hasInvitation={invitation !== null}
          />
        )}
        {account && (
          <Workbench
            key={account.id}
            invitation={invitation}
            onJoined={() => {
              window.history.replaceState(null, "", "/");
              setInvitation(null);
            }}
          />
        )}
      </main>
    </>
  );
}

const mount = document.getElementById("root");
if (mount === null)
  throw new Error("The browser entrypoint is missing its root element.");
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  };
}
