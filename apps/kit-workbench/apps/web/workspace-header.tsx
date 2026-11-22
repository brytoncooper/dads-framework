import { Tabs, TabsList, TabsTrigger } from "@dads-framework/ui/display";
import { Badge, Button } from "@dads-framework/ui/elements";
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Shield,
} from "@dads-framework/ui/icons";
import { useEffect, useState } from "react";
import type { Tenant } from "../../domains/tenants/web-client/index.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";

export type WorkspaceView = "notes" | "permissions";

type WorkspaceHeaderProps = {
  readonly tenant: Tenant;
  readonly view: WorkspaceView;
  readonly onViewChange: (view: WorkspaceView) => void;
};

type CopyState = "idle" | "copied" | "failed";

export function WorkspaceHeader({
  tenant,
  view,
  onViewChange,
}: WorkspaceHeaderProps) {
  const t = useWorkbenchCopy();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [tenant.id]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => {
      setCopyState("idle");
    }, 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copyState]);

  function copyTenantId() {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(tenant.id))
      .then(
        () => {
          setCopyState("copied");
        },
        () => {
          setCopyState("failed");
        },
      );
  }

  return (
    <header className="workspace-header">
      <div className="workspace-header-top">
        <div className="workspace-identity">
          <p className="eyebrow">{t("workbench.workspace.eyebrow")}</p>
          <h2 className="workspace-title">{tenant.name}</h2>
          <div className="tenant-id-bar">
            <Badge variant="secondary" className="tenant-id-label">
              {t("workbench.workspace.tenantId")}
            </Badge>
            <code className="tenant-id-code">{tenant.id}</code>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={copyTenantId}
            >
              {copyState === "copied" ? (
                <Check className="size-3" aria-hidden="true" />
              ) : (
                <Copy className="size-3" aria-hidden="true" />
              )}
              {t(copyLabelKey(copyState))}
            </Button>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href="/examples.html" className="workspace-exercises-link">
            {t("workbench.workspace.exercises")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
      <div className="workspace-header-nav">
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (next === "notes" || next === "permissions") onViewChange(next);
          }}
        >
          <TabsList aria-label={t("workbench.permissions.navigation")}>
            <TabsTrigger value="notes">
              <FileText className="size-4" aria-hidden="true" />
              {t("workbench.permissions.notes")}
            </TabsTrigger>
            <TabsTrigger value="permissions">
              <Shield className="size-4" aria-hidden="true" />
              {t("workbench.permissions.title")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </header>
  );
}

function copyLabelKey(state: CopyState) {
  if (state === "copied") return "workbench.workspace.copiedId";
  if (state === "failed") return "workbench.workspace.copyFailed";
  return "workbench.workspace.copyId";
}
