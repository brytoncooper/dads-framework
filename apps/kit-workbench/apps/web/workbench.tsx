import { Card, CardContent } from "@dads-framework/ui/elements";
import { useEffect, useState } from "react";
import {
  listTenants,
  type Tenant,
} from "../../domains/tenants/web-client/index.js";
import { describeFailure } from "./actions.js";
import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";
import { Notes } from "./notes.js";
import { AcceptInvitation, WorkspacePicker } from "./workspace-controls.js";

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
  const tenant =
    tenants?.find((entry) => entry.id === selected) ?? tenants?.[0];

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

  return (
    <div className="workspace-layout">
      <aside
        className="workspace-sidebar"
        aria-label={t("workbench.tenant.controls")}
      >
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
          onCreated={(created) => {
            setTenants((previous) => [...(previous ?? []), created]);
            setSelected(created.id);
            refresh();
          }}
        />
      </aside>
      {tenant ? (
        <Notes key={tenant.id} tenant={tenant} />
      ) : (
        <Card className="empty-workspace">
          <CardContent>
            <h2>{t("workbench.tenant.emptyTitle")}</h2>
            <p>{t("workbench.tenant.emptyBody")}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
