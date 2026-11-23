import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@dads-framework/ui/display";
import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Building2, ExternalLink } from "@dads-framework/ui/icons";
import { useEffect, useState } from "react";
import { listTenants, type Tenant } from "../../domains/tenants/web-client/index.js";
import { describeFailure } from "./actions.js";
import { useWorkbenchCopy, type WorkbenchCopyKey } from "./copy/workbench-copy.js";
import { Notes } from "./notes.js";
import { PermissionsDashboard } from "./permissions-dashboard.js";
import { AcceptInvitation, WorkspacePicker } from "./workspace-controls.js";
import { WorkspaceHeader, type WorkspaceView } from "./workspace-header.js";

type WorkbenchProps = {
  readonly invitation: string | null;
  readonly onJoined: () => void;
};

export function Workbench({ invitation, onJoined }: WorkbenchProps) {
  const t = useWorkbenchCopy();
  const [tenants, setTenants] = useState<Tenant[]>();
  const [selected, setSelected] = useState<Tenant["id"]>();
  const [loadError, setLoadError] = useState<WorkbenchCopyKey>();
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<WorkspaceView>("notes");
  const tenant = tenants?.find((entry) => entry.id === selected) ?? tenants?.[0];

  useEffect(() => {
    const controller = new AbortController();
    void listTenants(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setTenants(value);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [reload]);

  function refresh() {
    setLoadError(undefined);
    setReload((previous) => previous + 1);
  }

  function handleCreated(created: Tenant) {
    setTenants((previous) => [...(previous ?? []), created]);
    setSelected(created.id);
    refresh();
  }

  return (
    <div className="workspace-layout">
      <aside className="workspace-sidebar" aria-label={t("workbench.tenant.controls")}>
        {invitation && (
          <AcceptInvitation
            token={invitation}
            onAccepted={(id) => {
              onJoined();
              setSelected(id);
              refresh();
            }}
          />
        )}
        <WorkspacePicker
          tenants={tenants}
          selected={tenant?.id}
          loadError={loadError}
          onRetry={refresh}
          onSelect={setSelected}
          onCreated={handleCreated}
        />
      </aside>
      {tenant ? (
        <div className="workspace-content">
          <WorkspaceHeader tenant={tenant} view={view} onViewChange={setView} />
          {view === "notes" ? (
            <Notes key={tenant.id} tenant={tenant} />
          ) : (
            <PermissionsDashboard key={tenant.id} tenant={tenant} />
          )}
        </div>
      ) : (
        <EmptyWorkspaceCard />
      )}
    </div>
  );
}

function EmptyWorkspaceCard() {
  const t = useWorkbenchCopy();
  return (
    <Card className="empty-workspace">
      <CardContent>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2 aria-hidden="true" />
            </EmptyMedia>
            <p className="eyebrow">{t("workbench.tenant.emptyEyebrow")}</p>
            <EmptyTitle>{t("workbench.tenant.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("workbench.tenant.emptyBody")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="onboarding-content">
            <ol className="onboarding-steps">
              <li>{t("workbench.tenant.emptyStepCreate")}</li>
              <li>{t("workbench.tenant.emptyStepInvite")}</li>
              <li>{t("workbench.tenant.emptyStepExercises")}</li>
            </ol>
            <Button asChild variant="outline" size="sm">
              <a href="/examples.html" className="workspace-exercises-link">
                {t("workbench.workspace.exercises")}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </Button>
          </EmptyContent>
        </Empty>
      </CardContent>
    </Card>
  );
}
