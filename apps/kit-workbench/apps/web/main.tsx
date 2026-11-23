import { useWorkbenchCopy, type WorkbenchCopyKey } from "./copy/workbench-copy.js";
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
            <a href="/examples.html">{t("workbench.examples")}</a>
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
          <p className="eyebrow">{account ? account.email : t("workbench.starter")}</p>
          <h1>{account ? t("workbench.title.signedIn") : t("workbench.title.signedOut")}</h1>
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
        {account === undefined && failure === undefined && <p role="status">{t("workbench.session.loading")}</p>}
        {account === null && <AccountForm onSignIn={setAccount} hasInvitation={invitation !== null} />}
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
if (mount === null) throw new Error("The browser entrypoint is missing its root element.");
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
