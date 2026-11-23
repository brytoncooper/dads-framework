/**
 * The shared shape of a stored file in the attachment list and the attachment
 * viewer. Both read this type, so neither knows how a feature stores its files.
 */
export type AttachmentKind = "pdf" | "image" | "other";

export type AttachmentItem = {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
};

/** Called when a person asks to look at a file in place (not download it). */
export type AttachmentOpenHandler = (item: AttachmentItem) => void;

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

/**
 * What the viewer can show for a file. The MIME type decides first; the file
 * extension is only a fallback for generic types such as
 * `application/octet-stream`, which browsers and uploaders often send.
 */
export function attachmentKindOf(item: Pick<AttachmentItem, "contentType" | "fileName">): AttachmentKind {
  const mimeType = item.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) {
    // SVG can carry script and is not drawn reliably by every <img> consumer,
    // so it is offered as a download like any other unsupported type.
    return mimeType === "image/svg+xml" ? "other" : "image";
  }

  const extension = attachmentExtensionOf(item.fileName);
  if (extension === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "other";
}

/** Machine key for the file type: lowercase text after the last dot, or "". */
export function attachmentExtensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "";
  const extensionCode = fileName.slice(dotIndex + 1);
  return extensionCode.toLowerCase();
}

/** Human file sizes use decimal units ("1.2 MB"), never binary "MiB" jargon. */
export function fileSizeParts(bytes: number): {
  readonly value: number;
  readonly unit: "byte" | "kilobyte" | "megabyte";
} {
  if (bytes < 1000) return { value: bytes, unit: "byte" };
  if (bytes < 1_000_000) return { value: bytes / 1000, unit: "kilobyte" };
  return { value: bytes / 1_000_000, unit: "megabyte" };
}

/** "25 kB" text for a byte count; `formatNumber` is the caller's locale-aware formatter. */
export function formatFileSize(
  bytes: number,
  formatNumber: (value: number, options: Intl.NumberFormatOptions) => string,
): string {
  const size = fileSizeParts(bytes);
  return formatNumber(size.value, {
    style: "unit",
    unit: size.unit,
    unitDisplay: size.unit === "byte" ? "long" : "short",
    maximumFractionDigits: size.unit === "byte" ? 0 : 1,
  });
}
