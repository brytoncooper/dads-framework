import { PermissionDecisionTable } from "@dads-framework/ui/display";
import { Badge, Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Label } from "@dads-framework/ui/forms";
import { useEffect, useState } from "react";
import { readMemberPermissions, readPermissionRoster, type Tenant } from "../../domains/tenants/web-client/index.js";
import { describeFailure } from "./actions.js";
import { useWorkbenchCopy, type WorkbenchCopyKey } from "./copy/workbench-copy.js";

type Roster = Awaited<ReturnType<typeof readPermissionRoster>>;
type Decisions = Awaited<ReturnType<typeof readMemberPermissions>>;

const permissionLabels = [
  ["view", "workbench.permissions.view"],
  ["manageMembers", "workbench.permissions.manageMembers"],
  ["manageTenant", "workbench.permissions.manageTenant"],
] satisfies readonly (readonly [Exclude<keyof Decisions, "role">, WorkbenchCopyKey])[];

const roleLabels = {
  owner: "workbench.permissions.owner",
  admin: "workbench.permissions.admin",
  member: "workbench.permissions.member",
} satisfies Record<Decisions["role"], WorkbenchCopyKey>;

export function PermissionsDashboard({ tenant }: { readonly tenant: Tenant }) {
  const t = useWorkbenchCopy();
  const [load, setLoad] = useState(0);
  const [roster, setRoster] = useState<Roster>();
  const [error, setError] = useState<WorkbenchCopyKey>();
  const [selected, setSelected] = useState("");
  const member = roster?.members.find(({ accountId }) => accountId === selected);

  useEffect(() => {
    const controller = new AbortController();
    void readPermissionRoster(tenant.id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setRoster(value);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setError(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [tenant.id, load]);

  function refresh() {
    setRoster(undefined);
    setError(undefined);
    setLoad((value) => value + 1);
  }

  return (
    <section className="notes" aria-labelledby="permissions-workspace">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("workbench.permissions.title")}</p>
          <h2 id="permissions-workspace">{tenant.name}</h2>
        </div>
      </div>
      <Card>
        <CardContent className="permissions-content">
          {error && <PermissionFailure error={error} onRetry={refresh} />}
          {roster === undefined && error === undefined && <p role="status">{t("workbench.permissions.loading")}</p>}
          {roster?.members.length === 0 && <p>{t("workbench.permissions.empty")}</p>}
          {roster && roster.members.length > 0 && (
            <div className="field">
              <Label htmlFor="permission-member">{t("workbench.permissions.account")}</Label>
              <select
                id="permission-member"
                value={member?.accountId ?? ""}
                onChange={(event) => {
                  setSelected(event.currentTarget.value);
                }}
              >
                <option value="">{t("workbench.permissions.choose")}</option>
                {roster.members.map(({ accountId }) => (
                  <option key={accountId} value={accountId}>
                    {accountId}
                  </option>
                ))}
              </select>
            </div>
          )}
          {member && (
            <MemberDecisions
              key={member.accountId}
              tenantId={tenant.id}
              accountId={member.accountId}
              onRefresh={refresh}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function MemberDecisions({
  tenantId,
  accountId,
  onRefresh,
}: {
  readonly tenantId: string;
  readonly accountId: string;
  readonly onRefresh: () => void;
}) {
  const t = useWorkbenchCopy();
  const [decisions, setDecisions] = useState<Decisions>();
  const [error, setError] = useState<WorkbenchCopyKey>();

  useEffect(() => {
    const controller = new AbortController();
    void readMemberPermissions(tenantId, accountId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setDecisions(value);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setError(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [tenantId, accountId]);

  if (error) return <PermissionFailure error={error} onRetry={onRefresh} />;
  if (decisions === undefined) return <p role="status">{t("workbench.permissions.checking")}</p>;

  return (
    <>
      <div className="permission-role">
        {t("workbench.permissions.role")}
        <Badge variant="outline">{t(roleLabels[decisions.role])}</Badge>
      </div>
      <PermissionDecisionTable
        caption={t("workbench.permissions.effective")}
        permissionHeading={t("workbench.permissions.action")}
        decisionHeading={t("workbench.permissions.access")}
        allowedLabel={t("workbench.permissions.allowed")}
        deniedLabel={t("workbench.permissions.denied")}
        decisions={permissionLabels.map(([id, label]) => ({
          id,
          label: t(label),
          allowed: decisions[id],
        }))}
      />
    </>
  );
}

function PermissionFailure({ error, onRetry }: { readonly error: WorkbenchCopyKey; readonly onRetry: () => void }) {
  const t = useWorkbenchCopy();
  return (
    <div>
      <p className="error" role="alert">
        {t(error)}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("workbench.retry")}
      </Button>
    </div>
  );
}
