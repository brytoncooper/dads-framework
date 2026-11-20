/**
 * A `Content-Disposition` that always downloads, never renders, and keeps the
 * original name (RFC 6266 with an RFC 8187 UTF-8 `filename*`). The quoted
 * fallback replaces anything outside printable ASCII, and the characters that
 * would end the quoted string, with `_`.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*!]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
