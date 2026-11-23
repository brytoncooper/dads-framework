import { Alert, AlertDescription, StatusLamp } from "@dads-framework/ui/display";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Separator } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import { Building2, MailCheck, Plus } from "@dads-framework/ui/icons";
import type { SubmitEvent } from "react";
import { acceptTenantInvitation, createTenant, type Tenant } from "../../domains/tenants/web-client/index.js";
import { field, useAction } from "./actions.js";
import { useWorkbenchCopy, type WorkbenchCopyKey } from "./copy/workbench-copy.js";

type AcceptInvitationProps = {
  readonly token: string;
  readonly onAccepted: (tenantId: Tenant["id"]) => void;
};

export function AcceptInvitation({ token, onAccepted }: AcceptInvitationProps) {
  const t = useWorkbenchCopy();
  const action = useAction();

  function handleAccept() {
    void action.run(async () => {
      const joined = await acceptTenantInvitation(token);
      onAccepted(joined.tenantId);
    });
  }

  return (
    <Card className="sidebar-card">
      <CardHeader className="sidebar-card-header">
        <CardTitle className="sidebar-card-title">
          <MailCheck className="size-4" aria-hidden="true" />
          {t("workbench.invite.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="sidebar-card-body">
        <Button disabled={action.pending} onClick={handleAccept}>
          {t("workbench.invite.accept")}
        </Button>
        {action.error && (
          <Alert variant="destructive">
            <AlertDescription>{t(action.error)}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

type WorkspacePickerProps = {
  readonly tenants: readonly Tenant[] | undefined;
  readonly selected: Tenant["id"] | undefined;
  readonly loadError: WorkbenchCopyKey | undefined;
  readonly onSelect: (id: Tenant["id"]) => void;
  readonly onCreated: (value: Tenant) => void;
  readonly onRetry: () => void;
};

export function WorkspacePicker({ tenants, selected, loadError, onSelect, onCreated, onRetry }: WorkspacePickerProps) {
  const t = useWorkbenchCopy();
  const create = useAction();

  function handleCreate(event: SubmitEvent<HTMLFormElement>) {
    const element = event.currentTarget;
    create.submit(event, async (form) => {
      const created = await createTenant(field(form, "name"));
      element.reset();
      onCreated(created);
    });
  }

  return (
    <Card className="sidebar-card">
      <CardHeader className="sidebar-card-header">
        <div className="sidebar-heading-row">
          <CardTitle className="sidebar-card-title">
            <Building2 className="size-4" aria-hidden="true" />
            {t("workbench.tenant.title")}
          </CardTitle>
          {tenants && <Badge variant="secondary">{t("workbench.tenant.count", { count: tenants.length })}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="sidebar-card-body">
        {loadError && (
          <Alert variant="destructive">
            <AlertDescription>
              <span>{t(loadError)}</span>
              <Button variant="outline" size="xs" onClick={onRetry}>
                {t("workbench.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {tenants === undefined && loadError === undefined && (
          <p className="field-hint" role="status">
            {t("workbench.tenant.loading")}
          </p>
        )}
        {tenants && tenants.length > 0 && (
          <nav className="workspace-list-nav" aria-label={t("workbench.tenant.listLabel")}>
            <ul className="workspace-list">
              {tenants.map((entry) => {
                const isActive = entry.id === selected;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={isActive ? "workspace-pill workspace-pill-active" : "workspace-pill"}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => {
                        onSelect(entry.id);
                      }}
                    >
                      <span className="workspace-pill-main">
                        <StatusLamp tone={isActive ? "positive" : "neutral"} className="workspace-pill-lamp" />
                        <span className="workspace-pill-name">{entry.name}</span>
                      </span>
                      <span className="workspace-pill-meta">
                        <code className="workspace-pill-id">{entry.id.slice(0, 8)}</code>
                        {isActive && <Badge variant="outline">{t("workbench.tenant.activeBadge")}</Badge>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        <Separator />
        <form className="fields workspace-create" onSubmit={handleCreate}>
          <div className="field">
            <Label htmlFor="workspace-name">{t("workbench.tenant.name")}</Label>
            <Input
              id="workspace-name"
              name="name"
              maxLength={120}
              required
              placeholder={t("workbench.tenant.namePlaceholder")}
            />
          </div>
          {create.error && (
            <p role="alert" className="error">
              {t(create.error)}
            </p>
          )}
          <Button variant="outline" size="sm" disabled={create.pending}>
            <Plus className="size-4" aria-hidden="true" />
            {t("workbench.tenant.create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
