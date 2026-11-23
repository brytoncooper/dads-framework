import { Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label, Textarea } from "@dads-framework/ui/forms";
import { useState } from "react";
import { createNote } from "../../domains/notes/web-client/index.js";
import { inviteToTenant, type Tenant } from "../../domains/tenants/web-client/index.js";
import { field, useAction } from "./actions.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";

export function NewNote({ tenantId, onSaved }: { readonly tenantId: Tenant["id"]; readonly onSaved: () => void }) {
  const t = useWorkbenchCopy();
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardContent>
        <form
          className="fields"
          onSubmit={(event) => {
            const element = event.currentTarget;
            action.submit(event, async (form) => {
              setSaved(false);
              await createNote(tenantId, field(form, "text"));
              element.reset();
              setSaved(true);
              onSaved();
            });
          }}
        >
          <div className="field">
            <Label htmlFor="note-text">{t("workbench.notes.new")}</Label>
            <Textarea
              id="note-text"
              name="text"
              rows={3}
              required
              maxLength={2000}
              placeholder={t("workbench.notes.placeholder")}
            />
          </div>
          {action.error && (
            <p className="error" role="alert">
              {t(action.error)}
            </p>
          )}
          {saved && <p role="status">{t("workbench.notes.saved")}</p>}
          <Button disabled={action.pending}>{t("workbench.notes.add")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function InviteCollaborator({ tenantId }: { readonly tenantId: Tenant["id"] }) {
  const t = useWorkbenchCopy();
  const action = useAction();
  const [invited, setInvited] = useState(false);
  return (
    <details className="invite">
      <summary>{t("workbench.invite.open")}</summary>
      <form
        className="fields"
        onSubmit={(event) => {
          const element = event.currentTarget;
          action.submit(event, async (form) => {
            setInvited(false);
            await inviteToTenant(tenantId, field(form, "email"));
            element.reset();
            setInvited(true);
          });
        }}
      >
        <div className="field">
          <Label htmlFor="invite-email">{t("workbench.invite.email")}</Label>
          <Input id="invite-email" name="email" type="email" required />
        </div>
        {action.error && (
          <p className="error" role="alert">
            {t(action.error)}
          </p>
        )}
        {invited && <p role="status">{t("workbench.invite.sent")}</p>}
        <Button variant="outline" disabled={action.pending}>
          {t("workbench.invite.send")}
        </Button>
      </form>
    </details>
  );
}
