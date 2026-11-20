import { Badge, Button } from "@dads-framework/ui/elements";
import { useEffect, useState } from "react";
import {
  listNotes,
  notesExport,
  readFeatures,
} from "../../domains/notes/web-client/index.js";
import type { Tenant } from "../../domains/tenants/web-client/index.js";
import { describeFailure } from "./actions.js";
import {
  useWorkbenchCopy,
  type WorkbenchCopyKey,
} from "./copy/workbench-copy.js";
import { InviteCollaborator, NewNote } from "./note-forms.js";
import { NoteList } from "./note-list.js";

export function Notes({ tenant }: { readonly tenant: Tenant }) {
  const t = useWorkbenchCopy();
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof listNotes>>>();
  const [features, setFeatures] = useState<readonly string[]>();
  const [loadError, setLoadError] = useState<WorkbenchCopyKey>();

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listNotes(tenant.id, page, controller.signal),
      readFeatures(tenant.id, controller.signal),
    ]).then(
      ([result, state]) => {
        if (controller.signal.aborted) return;
        setNotes(result);
        setFeatures(state.features);
      },
      (fault: unknown) => {
        if (!controller.signal.aborted) setLoadError(describeFailure(fault));
      },
    );
    return () => {
      controller.abort();
    };
  }, [tenant.id, page, reload]);

  function refresh() {
    setLoadError(undefined);
    setReload((previous) => previous + 1);
  }

  const exportEnabled = features?.includes(notesExport) === true;
  return (
    <section className="notes" aria-labelledby="workspace-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("workbench.notes.eyebrow")}</p>
          <h2 id="workspace-heading">{tenant.name}</h2>
        </div>
        {features && (
          <Badge variant="outline">
            {t(
              exportEnabled
                ? "workbench.notes.export.on"
                : "workbench.notes.export.off",
            )}
          </Badge>
        )}
      </div>
      <NewNote tenantId={tenant.id} onSaved={refresh} />
      {loadError && (
        <p className="error" role="alert">
          {t(loadError)}{" "}
          <Button variant="outline" size="sm" onClick={refresh}>
            {t("workbench.retry")}
          </Button>
        </p>
      )}
      {notes === undefined && loadError === undefined && (
        <p role="status">{t("workbench.notes.loading")}</p>
      )}
      {notes && (
        <NoteList
          notes={notes}
          page={page}
          exportEnabled={exportEnabled}
          onChangePage={setPage}
        />
      )}
      <InviteCollaborator tenantId={tenant.id} />
    </section>
  );
}
