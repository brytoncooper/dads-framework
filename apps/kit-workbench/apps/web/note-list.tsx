import type { ApiPage } from "@dads-framework/client";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@dads-framework/ui/display";
import { Badge, Button, Card, CardContent } from "@dads-framework/ui/elements";
import { Input, Label } from "@dads-framework/ui/forms";
import { FileSpreadsheet, FileText, Search, X } from "@dads-framework/ui/icons";
import { useState } from "react";
import { exportNote, type Note, type NoteExportFormat } from "../../domains/notes/web-client/index.js";
import { useAction } from "./actions.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";
import { NoteAttachments } from "./note-attachments.js";

type NoteListProps = {
  readonly notes: ApiPage<Note>;
  readonly page: number;
  readonly exportEnabled: boolean;
  readonly onChangePage: (page: number) => void;
};

export function NoteList({ notes, page, exportEnabled, onChangePage }: NoteListProps) {
  const t = useWorkbenchCopy();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized ? notes.items.filter((note) => matchesNote(note, normalized)) : notes.items;
  const totalPages = Math.max(1, Math.ceil(notes.meta.total / notes.meta.perPage));
  const showPagination = notes.meta.page > 1 || notes.meta.total > notes.meta.perPage;

  return (
    <div className="notes-list">
      {notes.items.length > 0 && (
        <NoteSearchBar
          query={query}
          shownCount={filtered.length}
          pageCount={notes.items.length}
          onQueryChange={setQuery}
        />
      )}
      {notes.items.length === 0 && (
        <Card className="empty-notes-card">
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t("workbench.notes.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("workbench.notes.emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      )}
      {notes.items.length > 0 && filtered.length === 0 && (
        <Card className="empty-notes-card">
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t("workbench.notes.noMatchTitle")}</EmptyTitle>
                <EmptyDescription>{t("workbench.notes.noMatchDescription")}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                  }}
                >
                  {t("workbench.notes.clearSearch")}
                </Button>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      )}
      {filtered.map((note) => (
        <NoteRow key={note.id} note={note} exportEnabled={exportEnabled} />
      ))}
      {showPagination && (
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
          <span className="pagination-label">
            {t("workbench.notes.pageSummary", {
              number: notes.meta.page,
              pages: totalPages,
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page !== notes.meta.page || page * notes.meta.perPage >= notes.meta.total}
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

type NoteSearchBarProps = {
  readonly query: string;
  readonly shownCount: number;
  readonly pageCount: number;
  readonly onQueryChange: (value: string) => void;
};

function NoteSearchBar({ query, shownCount, pageCount, onQueryChange }: NoteSearchBarProps) {
  const t = useWorkbenchCopy();
  return (
    <div className="notes-toolbar">
      <div className="notes-search">
        <Label htmlFor="notes-filter" className="sr-only">
          {t("workbench.notes.searchLabel")}
        </Label>
        <Search className="notes-search-icon size-4" aria-hidden="true" />
        <Input
          id="notes-filter"
          type="search"
          value={query}
          className="notes-search-input"
          placeholder={t("workbench.notes.searchPlaceholder")}
          onChange={(event) => {
            onQueryChange(event.currentTarget.value);
          }}
        />
        {query.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              onQueryChange("");
            }}
          >
            <X className="size-3" aria-hidden="true" />
            {t("workbench.notes.clearSearch")}
          </Button>
        )}
      </div>
      <Badge variant="outline">{t("workbench.notes.count", { shown: shownCount, total: pageCount })}</Badge>
    </div>
  );
}

const exportFormats: readonly NoteExportFormat[] = ["csv", "pdf"];

function NoteRow({ note, exportEnabled }: { readonly note: Note; readonly exportEnabled: boolean }) {
  const t = useWorkbenchCopy();
  const action = useAction();
  const stats = summarizeNote(note.text);
  const shortId = note.id.slice(0, 8);

  function download(format: NoteExportFormat) {
    return action.run(async () => {
      const file = await exportNote(note.tenantId, note.id, format);
      downloadNote(file, format);
    });
  }

  return (
    <article className="note">
      <div className="note-header">
        <div className="note-meta">
          <code className="note-id-chip">{t("workbench.notes.noteId", { shortId })}</code>
          <span className="note-stats">
            {t("workbench.notes.summary", {
              words: stats.words,
              chars: stats.chars,
            })}
          </span>
        </div>
        {exportEnabled ? (
          <div className="note-actions">
            {exportFormats.map((format) => (
              <Button
                key={format}
                variant="outline"
                size="xs"
                disabled={action.pending}
                onClick={() => void download(format)}
              >
                {format === "csv" ? (
                  <FileSpreadsheet className="size-3.5" aria-hidden="true" />
                ) : (
                  <FileText className="size-3.5" aria-hidden="true" />
                )}
                {t(format === "csv" ? "workbench.notes.export.csv" : "workbench.notes.export.pdf")}
              </Button>
            ))}
          </div>
        ) : (
          <span className="note-export-hint">{t("workbench.notes.export.locked")}</span>
        )}
      </div>
      <p className="note-body">{note.text}</p>
      {action.error && (
        <p className="error" role="alert">
          {t(action.error)}
        </p>
      )}
      <NoteAttachments tenantId={note.tenantId} noteId={note.id} />
    </article>
  );
}

function matchesNote(note: Note, query: string): boolean {
  return note.text.toLocaleLowerCase().includes(query) || note.id.toLocaleLowerCase().includes(query);
}

function summarizeNote(text: string): {
  readonly words: number;
  readonly chars: number;
} {
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
  return { words, chars: text.length };
}

function downloadNote(file: { readonly base64: string; readonly contentType: string }, format: NoteExportFormat) {
  const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
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
