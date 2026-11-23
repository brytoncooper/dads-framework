import { StatusBadge } from "@dads-framework/ui/display";
import { Badge, Button } from "@dads-framework/ui/elements";
import { Label, Textarea } from "@dads-framework/ui/forms";
import { Paperclip, RefreshCw } from "@dads-framework/ui/icons";
import { useState, type SubmitEvent } from "react";
import { field, useAction } from "./actions.js";
import { useWorkbenchCopy } from "./copy/workbench-copy.js";
import { readNoteAttachment, uploadNoteAttachment, type NoteAttachmentRecord } from "./note-attachments-client.js";

type AttachmentItem = {
  readonly fileId: string;
  readonly record: NoteAttachmentRecord | undefined;
  readonly expanded: boolean;
};

type NoteAttachmentsProps = {
  readonly tenantId: string;
  readonly noteId: string;
};

export function NoteAttachments({ tenantId, noteId }: NoteAttachmentsProps) {
  const t = useWorkbenchCopy();
  const upload = useAction();
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const inputId = `attachment-text-${noteId}`;

  function prependAttachment(fileId: string, record: NoteAttachmentRecord) {
    setItems((current) => [{ fileId, record, expanded: true }, ...current]);
  }

  function updateAttachment(fileId: string, updater: (item: AttachmentItem) => AttachmentItem) {
    setItems((current) => current.map((item) => (item.fileId === fileId ? updater(item) : item)));
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    const element = event.currentTarget;
    upload.submit(event, async (form) => {
      const created = await uploadNoteAttachment(tenantId, noteId, field(form, "attachment"));
      const record = await readNoteAttachment(tenantId, noteId, created.fileId);
      element.reset();
      prependAttachment(created.fileId, record);
    });
  }

  return (
    <details className="note-attachments">
      <summary className="note-attachments-summary">
        <span className="note-attachments-title">
          <Paperclip className="size-3.5" aria-hidden="true" />
          {t("workbench.notes.attachments.title")}
        </span>
        {items.length > 0 && (
          <Badge variant="secondary">{t("workbench.notes.attachments.count", { count: items.length })}</Badge>
        )}
      </summary>
      <div className="note-attachments-body">
        <form className="fields" onSubmit={handleSubmit}>
          <div className="field">
            <Label htmlFor={inputId}>{t("workbench.notes.attachments.label")}</Label>
            <Textarea
              id={inputId}
              name="attachment"
              rows={2}
              required
              maxLength={16384}
              placeholder={t("workbench.notes.attachments.placeholder")}
            />
          </div>
          {upload.error && (
            <p className="error" role="alert">
              {t(upload.error)}
            </p>
          )}
          <Button variant="outline" size="sm" disabled={upload.pending}>
            {t("workbench.notes.attachments.upload")}
          </Button>
        </form>
        {items.length === 0 ? (
          <p className="field-hint">{t("workbench.notes.attachments.empty")}</p>
        ) : (
          <ul className="attachment-list">
            {items.map((item) => (
              <AttachmentRow
                key={item.fileId}
                tenantId={tenantId}
                noteId={noteId}
                item={item}
                onUpdate={(updater) => {
                  updateAttachment(item.fileId, updater);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

type AttachmentRowProps = {
  readonly tenantId: string;
  readonly noteId: string;
  readonly item: AttachmentItem;
  readonly onUpdate: (updater: (item: AttachmentItem) => AttachmentItem) => void;
};

function AttachmentRow({ tenantId, noteId, item, onUpdate }: AttachmentRowProps) {
  const t = useWorkbenchCopy();
  const inspectAction = useAction();

  function applyRecord(record: NoteAttachmentRecord) {
    onUpdate((current) => ({ ...current, record, expanded: true }));
  }

  function refreshAttachment() {
    void inspectAction.run(async () => {
      const record = await readNoteAttachment(tenantId, noteId, item.fileId);
      applyRecord(record);
    });
  }

  function toggleExpanded() {
    onUpdate((current) => ({ ...current, expanded: !current.expanded }));
  }

  const inspection = item.record?.inspection ?? null;
  const shortId = item.fileId.slice(0, 8);

  return (
    <li className="attachment-item">
      <div className="attachment-row-header">
        <code className="note-id-chip">{t("workbench.notes.attachments.fileLabel", { shortId })}</code>
        <div className="attachment-row-actions">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={inspectAction.pending}
            onClick={refreshAttachment}
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            {t("workbench.notes.attachments.refresh")}
          </Button>
          <Button type="button" variant="secondary" size="xs" onClick={toggleExpanded}>
            {t(item.expanded ? "workbench.notes.attachments.hide" : "workbench.notes.attachments.inspect")}
          </Button>
        </div>
      </div>
      <div className="attachment-status">
        {inspection ? (
          <StatusBadge tone="positive">
            {t("workbench.notes.attachments.digestReady", {
              bytes: inspection.bytes,
              digest: inspection.sha256.slice(0, 12),
            })}
          </StatusBadge>
        ) : (
          <StatusBadge tone="information">{t("workbench.notes.attachments.pendingDigest")}</StatusBadge>
        )}
      </div>
      {inspectAction.error && (
        <p className="error" role="alert">
          {t(inspectAction.error)}
        </p>
      )}
      {item.expanded && item.record && <pre className="attachment-preview">{item.record.text}</pre>}
    </li>
  );
}
