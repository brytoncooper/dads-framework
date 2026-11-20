import { Button } from "@dads-framework/ui/elements";
import type { ApiPage } from "@dads-framework/client-request-transport";
import {
  exportNote,
  type Note,
  type NoteExportFormat,
} from "../../domains/notes/web-client/index.js";
import { useAction } from "./actions.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";

type NoteListProps = {
  readonly notes: ApiPage<Note>;
  readonly page: number;
  readonly exportEnabled: boolean;
  readonly onChangePage: (page: number) => void;
};

export function NoteList({
  notes,
  page,
  exportEnabled,
  onChangePage,
}: NoteListProps) {
  const t = useWorkbenchCopy();
  return (
    <div className="notes-list">
      {notes.items.length === 0 && <p>{t("workbench.notes.empty")}</p>}
      {notes.items.map((note) => (
        <NoteRow key={note.id} note={note} exportEnabled={exportEnabled} />
      ))}
      {(notes.meta.page > 1 || notes.meta.total > notes.meta.perPage) && (
        <nav className="pagination" aria-label={t("workbench.notes.pages")}>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || page !== notes.meta.page}
            onClick={() => {
              onChangePage(page - 1);
            }}
          >
            {t("workbench.notes.previous")}
          </Button>
          <span>{t("workbench.notes.page", { number: notes.meta.page })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={
              page !== notes.meta.page ||
              page * notes.meta.perPage >= notes.meta.total
            }
            onClick={() => {
              onChangePage(page + 1);
            }}
          >
            {t("workbench.notes.next")}
          </Button>
        </nav>
      )}
    </div>
  );
}

const exportFormats: readonly NoteExportFormat[] = ["csv", "pdf"];

function NoteRow({
  note,
  exportEnabled,
}: {
  readonly note: Note;
  readonly exportEnabled: boolean;
}) {
  const t = useWorkbenchCopy();
  const action = useAction();
  function download(format: NoteExportFormat) {
    return action.run(async () => {
      const file = await exportNote(note.tenantId, note.id, format);
      downloadNote(file, format);
    });
  }

  return (
    <article className="note">
      <p>{note.text}</p>
      {exportEnabled && (
        <div className="note-actions">
          {exportFormats.map((format) => (
            <Button
              key={format}
              variant="outline"
              size="sm"
              disabled={action.pending}
              onClick={() => void download(format)}
            >
              {t(
                format === "csv"
                  ? "workbench.notes.export.csv"
                  : "workbench.notes.export.pdf",
              )}
            </Button>
          ))}
        </div>
      )}
      {action.error && (
        <p className="error" role="alert">
          {t(action.error)}
        </p>
      )}
    </article>
  );
}

function downloadNote(
  file: { readonly base64: string; readonly contentType: string },
  format: NoteExportFormat,
) {
  const bytes = Uint8Array.from(atob(file.base64), (character) =>
    character.charCodeAt(0),
  );
  const content = new Blob([bytes], { type: file.contentType });
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = `note.${format}`;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
