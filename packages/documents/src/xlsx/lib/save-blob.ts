const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Hand the browser a workbook as a named file download. No-op without a DOM
 * (node test runs) — the download anchor needs a document to click.
 */
export function saveArrayBufferAsFile(fileName: string, data: ArrayBuffer): void {
  if (typeof document === "undefined") return;

  const objectUrl = URL.createObjectURL(new Blob([data], { type: XLSX_MIME_TYPE }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
