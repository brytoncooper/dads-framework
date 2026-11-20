import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import {
  acceptTenantInvitation,
  createTenant,
  type Tenant,
} from "../../domains/tenants/web-client/index.js";
import { field, useAction } from "./actions.js";
import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";

type AcceptInvitationProps = {
  readonly token: string;
  readonly onAccepted: (tenantId: Tenant["id"]) => void;
};

export function AcceptInvitation({ token, onAccepted }: AcceptInvitationProps) {
  const t = useWorkbenchCopy();
  const action = useAction();
  return (
    <Card>
      <CardContent>
        <h2>{t("workbench.invite.title")}</h2>
        <Button
          disabled={action.pending}
          onClick={() =>
            void action.run(async () => {
              const joined = await acceptTenantInvitation(token);
              onAccepted(joined.tenantId);
            })
          }
        >
          {t("workbench.invite.accept")}
        </Button>
        {action.error && (
          <p role="alert" className="error">
            {t(action.error)}
          </p>
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

export function WorkspacePicker({
  tenants,
  selected,
  loadError,
  onSelect,
  onCreated,
  onRetry,
}: WorkspacePickerProps) {
  const t = useWorkbenchCopy();
  const create = useAction();
  return (
    <Card>
      <CardContent>
        <h2>{t("workbench.tenant.title")}</h2>
        {loadError && (
          <p className="error" role="alert">
            {t(loadError)}{" "}
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("workbench.retry")}
            </Button>
          </p>
        )}
        {tenants === undefined && loadError === undefined && (
          <p role="status">{t("workbench.tenant.loading")}</p>
        )}
        {tenants && tenants.length > 0 && (
          <div className="field">
            <Label htmlFor="workspace">{t("workbench.tenant.active")}</Label>
            <select
              id="workspace"
              value={selected ?? ""}
              onChange={(event) => {
                onSelect(event.currentTarget.value);
              }}
            >
              {tenants.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <form
          className="fields workspace-create"
          onSubmit={(event) => {
            const element = event.currentTarget;
            create.submit(event, async (form) => {
              const created = await createTenant(field(form, "name"));
              element.reset();
              onCreated(created);
            });
          }}
        >
          <div className="field">
            <Label htmlFor="workspace-name">{t("workbench.tenant.name")}</Label>
            <Input id="workspace-name" name="name" maxLength={120} required />
          </div>
          {create.error && (
            <p role="alert" className="error">
              {t(create.error)}
            </p>
          )}
          <Button variant="outline" disabled={create.pending}>
            {t("workbench.tenant.create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
